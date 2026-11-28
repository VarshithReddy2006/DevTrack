// src/middleware/originValidation.ts — defence in depth against cross-site state changes.
//
// For POST/PUT/PATCH/DELETE:
//   - Origin (or, failing that, Referer) must be on the allowlist when the browser sends one
//   - Sec-Fetch-Site: cross-site is refused unless the Origin is explicitly allowlisted (a configured CORS origin)
//   - requests with none of these headers (curl, server-to-server) pass, since they carry their own bearer token
//   - an opaque `Origin: null` (sandboxed iframe, desktop shell) needs the shared secret header, when one is configured
// WebSocket handshakes are GETs but get the same checks. Other safe methods are never checked here,
// and exempt path prefixes (signed webhooks) apply to state-changing methods only.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { errorResponse } from '../shared/response.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const NULL_ORIGIN_SECRET_HEADER = 'x-devtrack-origin-secret';

export interface OriginValidationOptions {
  /** Exact origins, or a wildcard subdomain such as https://*.preview.devtrack.sh. */
  allowedOrigins: string[];
  /** Path prefixes skipped entirely. These endpoints must verify their own signature. */
  exemptPathPrefixes?: string[];
  /** Secret that lets `Origin: null` through when sent in the x-devtrack-origin-secret header. Unset: always refused. */
  nullOriginSecret?: string;
  /** Called on each rejection, for monitoring. Must not throw. */
  onReject?: (info: { method: string; path: string; origin?: string; secFetchSite?: string; reason: string }) => void;
}

export const DEFAULT_EXEMPT_PREFIXES = ['/api/v2/webhooks/'];

function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Parses ALLOWED_ORIGINS style input: comma separated, blanks ignored. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function originMatches(origin: string, allowed: string[]): boolean {
  const o = normalizeOrigin(origin);
  if (!o) return false;
  const host = new URL(o);
  for (const entry of allowed) {
    const star = entry.match(/^(https?):\/\/\*\.([^:/]+)(?::(\d+))?$/i);
    if (star) {
      const starProto = `${star[1].toLowerCase()}:`;
      const starDomain = star[2].toLowerCase();
      const starPort = star[3] ?? '';

      // Check protocol
      if (host.protocol !== starProto) continue;

      // Check port
      if (host.port !== starPort) continue;

      // *.example.com matches a.example.com and a.b.example.com, never example.com itself or evilexample.com.
      if (host.hostname.endsWith(`.${starDomain}`) && host.hostname.length > starDomain.length + 1) {
        return true;
      }
      continue;
    }
    if (normalizeOrigin(entry) === o) return true;
  }
  return false;
}

/** The part of a request these checks read, so a raw `upgrade` IncomingMessage works too. */
export interface OriginCheckRequest {
  headers: IncomingHttpHeaders;
}

type OriginPolicy = Pick<OriginValidationOptions, 'allowedOrigins' | 'nullOriginSecret'>;

function header(req: OriginCheckRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function secFetchSite(req: OriginCheckRequest): string | undefined {
  const raw = header(req, 'sec-fetch-site');
  return raw ? raw.toLowerCase().trim() : undefined;
}

/** True when the Upgrade header asks for a WebSocket, in any letter case. */
export function isWebSocketUpgrade(req: OriginCheckRequest): boolean {
  return (header(req, 'upgrade') ?? '').split(',').some((t) => t.trim().toLowerCase() === 'websocket');
}

/** An Origin header is scheme://host[:port] and nothing else: no credentials, path, query or fragment. */
function isBareOrigin(value: string): boolean {
  return /^https?:\/\/[^/\\?#@\s]+$/i.test(value);
}

function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected || given === undefined) return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Returns why a request's origin headers are unacceptable, or null when they pass.
 * Call it from a `server.on('upgrade')` handler too: Express middleware never sees those requests.
 */
export function originRejectionReason(req: OriginCheckRequest, policy: OriginPolicy): string | null {
  const origin = header(req, 'origin');

  if (origin !== undefined) {
    if (origin === 'null' && secretMatches(header(req, NULL_ORIGIN_SECRET_HEADER), policy.nullOriginSecret)) {
      return null;
    }
    // an allowlisted origin is a configured CORS origin, even when the browser calls it cross-site
    return isBareOrigin(origin) && originMatches(origin, policy.allowedOrigins) ? null : 'origin_not_allowed';
  }

  if (secFetchSite(req) === 'cross-site') return 'cross_site';

  const referer = header(req, 'referer');
  if (referer !== undefined && !originMatches(referer, policy.allowedOrigins)) return 'referer_not_allowed';

  return null;
}

export function originValidation(options: OriginValidationOptions): RequestHandler {
  const exempt = options.exemptPathPrefixes ?? DEFAULT_EXEMPT_PREFIXES;

  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method ? req.method.toUpperCase() : '';
    const upgrade = isWebSocketUpgrade(req);
    if (!upgrade && !STATE_CHANGING.has(method)) return next();
    const path = req.originalUrl ?? req.url ?? '';
    if (!upgrade && exempt.some((p) => path.startsWith(p))) return next();

    const reason = originRejectionReason(req, options);
    if (reason === null) return next();

    try {
      options.onReject?.({
        method: req.method,
        path,
        origin: header(req, 'origin'),
        secFetchSite: secFetchSite(req),
        reason,
      });
    } catch {
      // monitoring must not change the response
    }
    errorResponse(res, 'Forbidden', 'FORBIDDEN', 403);
  };
}
