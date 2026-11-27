// src/modules/profile/customDomain.service.ts: custom portfolio domains.
//
// Ownership is proven with a DNS TXT challenge: the owner publishes a random token at
// _devtrack-challenge.<domain>, and the domain itself must be a CNAME to the DevTrack edge.
// Lookups go through an injectable resolver so tests never touch real DNS.

import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import {
  CustomDomain,
  type CustomDomainErrorCode,
  type CustomDomainStatus,
  type ICustomDomain,
} from '../../db/models/customDomain.model.js';

export const CHALLENGE_LABEL = '_devtrack-challenge';
export const DNS_TIMEOUT_MS = 5_000;

/** The two lookups the challenge needs. node:dns/promises Resolver satisfies it. */
export interface DnsResolver {
  resolveTxt(hostname: string): Promise<string[][]>;
  resolveCname(hostname: string): Promise<string[]>;
}

export interface DnsCheckOptions {
  resolver?: DnsResolver;
  timeoutMs?: number;
  cnameTarget?: string;
}

export interface DnsError {
  code: CustomDomainErrorCode;
  message: string;
}

export interface RecordCheck {
  ok: boolean;
  found: string[];
  error: DnsError | null;
}

export interface DnsCheckResult {
  verified: boolean;
  /** Every failure was a timeout or resolver error, so the records may well still be there. */
  transient: boolean;
  txt: RecordCheck;
  cname: RecordCheck;
  error: DnsError | null;
}

export interface DnsRecordInstruction {
  type: 'TXT' | 'CNAME';
  name: string;
  value: string;
}

export interface CustomDomainView {
  id: string;
  domain: string;
  status: CustomDomainStatus;
  records: DnsRecordInstruction[];
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  suspendedAt: Date | null;
  lastError: DnsError | null;
}

export type CustomDomainErrorKind = 'INVALID_DOMAIN' | 'DOMAIN_TAKEN' | 'NOT_FOUND';

export class CustomDomainError extends Error {
  constructor(readonly kind: CustomDomainErrorKind, message: string) {
    super(message);
    this.name = 'CustomDomainError';
  }
}

// --- Domain input -------------------------------------------------------------

const HOSTNAME_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function cnameTarget(): string {
  return normalizeHost(env.CUSTOM_DOMAIN_CNAME_TARGET);
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/** Validates and normalizes a hostname such as `Portfolio.AlexChen.dev.` to `portfolio.alexchen.dev`. */
export function parseDomain(input: string): string {
  const domain = normalizeHost(input);
  if (/[/:]/.test(domain)) {
    throw new CustomDomainError('INVALID_DOMAIN', 'Enter only the hostname, for example portfolio.example.com, without https:// or a path');
  }
  if (!HOSTNAME_PATTERN.test(domain)) {
    throw new CustomDomainError('INVALID_DOMAIN', `${domain || 'This'} is not a valid domain name`);
  }
  // The edge's own zone (devtrack.sh for cname.devtrack.sh) can never be claimed.
  const target = cnameTarget();
  const edgeZone = target.split('.').slice(1).join('.');
  for (const reserved of [target, edgeZone]) {
    if (reserved.includes('.') && (domain === reserved || domain.endsWith(`.${reserved}`))) {
      throw new CustomDomainError('INVALID_DOMAIN', `${domain} belongs to DevTrack and cannot be used as a custom domain`);
    }
  }
  return domain;
}

export function generateVerificationToken(): string {
  return `devtrack-verification=${randomBytes(24).toString('base64url')}`;
}

export function challengeHost(domain: string): string {
  return `${CHALLENGE_LABEL}.${domain}`;
}

export function requiredDnsRecords(domain: string, token: string): DnsRecordInstruction[] {
  return [
    { type: 'TXT', name: challengeHost(domain), value: token },
    { type: 'CNAME', name: domain, value: cnameTarget() },
  ];
}

export function toCustomDomainView(doc: Pick<ICustomDomain, 'domain' | 'verificationToken' | 'status' | 'verifiedAt' | 'lastCheckedAt' | 'suspendedAt' | 'lastError'> & { _id: Types.ObjectId | unknown }): CustomDomainView {
  return {
    id: String(doc._id),
    domain: doc.domain,
    status: doc.status,
    records: requiredDnsRecords(doc.domain, doc.verificationToken),
    verifiedAt: doc.verifiedAt ?? null,
    lastCheckedAt: doc.lastCheckedAt ?? null,
    suspendedAt: doc.suspendedAt ?? null,
    lastError: doc.lastError ? { code: doc.lastError.code, message: doc.lastError.message } : null,
  };
}

// --- DNS checks -------------------------------------------------------------

let defaultResolver: DnsResolver | undefined;

function systemResolver(): DnsResolver {
  // Per-attempt timeout; the overall budget is enforced by withTimeout below.
  defaultResolver ??= new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  return defaultResolver;
}

class DnsTimeoutError extends Error {
  readonly code = 'ETIMEOUT';
}

function withTimeout<T>(lookup: Promise<T>, timeoutMs: number, host: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DnsTimeoutError(`DNS lookup for ${host} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([lookup, timeout]).finally(() => clearTimeout(timer));
}

function lookupError(error: unknown, type: 'TXT' | 'CNAME', host: string, timeoutMs: number): DnsError {
  const code = (error as { code?: string }).code;
  if (code === 'ENOTFOUND' || code === 'ENODATA') {
    return type === 'TXT'
      ? { code: 'TXT_MISSING', message: `No TXT record found at ${host}` }
      : { code: 'CNAME_MISSING', message: `No CNAME record found for ${host}. Point it at ${cnameTarget()} (apex domains cannot use a CNAME, use a subdomain such as www)` };
  }
  if (code === 'ETIMEOUT') {
    return { code: 'DNS_TIMEOUT', message: `${type} lookup for ${host} timed out after ${timeoutMs}ms` };
  }
  return { code: 'DNS_ERROR', message: `${type} lookup for ${host} failed${code ? ` (${code})` : ''}` };
}

async function checkTxt(domain: string, token: string, resolver: DnsResolver, timeoutMs: number): Promise<RecordCheck> {
  const host = challengeHost(domain);
  try {
    // A TXT record can be split into several strings; they form one value.
    const found = (await withTimeout(resolver.resolveTxt(host), timeoutMs, host)).map(chunks => chunks.join(''));
    if (found.includes(token)) return { ok: true, found, error: null };
    return {
      ok: false,
      found,
      error: found.length === 0
        ? { code: 'TXT_MISSING', message: `No TXT record found at ${host}` }
        : { code: 'TXT_MISMATCH', message: `The TXT record at ${host} does not match your verification token` },
    };
  } catch (error) {
    return { ok: false, found: [], error: lookupError(error, 'TXT', host, timeoutMs) };
  }
}

async function checkCname(domain: string, target: string, resolver: DnsResolver, timeoutMs: number): Promise<RecordCheck> {
  try {
    const found = (await withTimeout(resolver.resolveCname(domain), timeoutMs, domain)).map(normalizeHost);
    if (found.includes(target)) return { ok: true, found, error: null };
    return {
      ok: false,
      found,
      error: found.length === 0
        ? lookupError({ code: 'ENODATA' }, 'CNAME', domain, timeoutMs)
        : { code: 'CNAME_MISMATCH', message: `${domain} is a CNAME for ${found.join(', ')}, expected ${target}` },
    };
  } catch (error) {
    return { ok: false, found: [], error: lookupError(error, 'CNAME', domain, timeoutMs) };
  }
}

const TRANSIENT_CODES = new Set<CustomDomainErrorCode>(['DNS_TIMEOUT', 'DNS_ERROR']);

/** Checks the TXT challenge and the CNAME in parallel. Never throws. */
export async function checkDomainRecords(domain: string, token: string, options: DnsCheckOptions = {}): Promise<DnsCheckResult> {
  const resolver = options.resolver ?? systemResolver();
  const timeoutMs = options.timeoutMs ?? DNS_TIMEOUT_MS;
  const target = normalizeHost(options.cnameTarget ?? cnameTarget());
  const [txt, cname] = await Promise.all([
    checkTxt(domain, token, resolver, timeoutMs),
    checkCname(domain, target, resolver, timeoutMs),
  ]);
  const errors = [txt.error, cname.error].filter((error): error is DnsError => error !== null);
  return {
    verified: txt.ok && cname.ok,
    transient: errors.length > 0 && errors.every(error => TRANSIENT_CODES.has(error.code)),
    txt,
    cname,
    error: errors[0] ?? null,
  };
}

// --- Registration ----------------------------------------------------------------

/**
 * Registers (or replaces) the user's custom domain and returns the DNS records to add.
 * Registering the same domain again keeps the token, so records already published stay valid.
 */
export async function registerCustomDomain(userId: string, input: string): Promise<CustomDomainView> {
  const domain = parseDomain(input);
  const taken = await CustomDomain.exists({ domain, status: 'active', userId: { $ne: userId } });
  if (taken) throw new CustomDomainError('DOMAIN_TAKEN', `${domain} is already connected to another DevTrack profile`);

  const existing = await CustomDomain.findOne({ userId }).lean();
  if (existing?.domain === domain) return toCustomDomainView(existing);

  const doc = await CustomDomain.findOneAndUpdate(
    { userId },
    {
      $set: {
        domain,
        verificationToken: generateVerificationToken(),
        status: 'pending',
        verifiedAt: null,
        lastCheckedAt: null,
        suspendedAt: null,
        lastError: null,
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();
  return toCustomDomainView(doc!);
}

export async function getCustomDomain(userId: string): Promise<CustomDomainView | null> {
  const doc = await CustomDomain.findOne({ userId }).lean();
  return doc ? toCustomDomainView(doc) : null;
}

export async function findCustomDomainForVerification(userId: string): Promise<CustomDomainView> {
  const view = await getCustomDomain(userId);
  if (!view) throw new CustomDomainError('NOT_FOUND', 'Register a custom domain before verifying it');
  return view;
}
