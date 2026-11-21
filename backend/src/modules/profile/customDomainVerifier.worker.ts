// src/modules/profile/customDomainVerifier.worker.ts: DNS verification jobs for custom domains.
//
// Both jobs run on the system-maintenance queue (worker-maintenance):
//   verify_custom_domain   right after the owner asks for verification
//   audit_custom_domains   weekly re-check of every active domain
// Either one suspends an active domain whose TXT challenge or CNAME is gone. A lookup that only
// timed out or hit a resolver error leaves an active domain active, so a DNS hiccup cannot take
// a working portfolio offline.

import { CustomDomain, type CustomDomainStatus, type ICustomDomain } from '../../db/models/customDomain.model.js';
import { logger } from '../../shared/logger.js';
import { getSystemMaintenanceQueue } from '../../shared/jobs/queueFactory.js';
import type { SystemMaintenanceJobData } from '../../shared/jobs/types.js';
import { checkDomainRecords, type DnsCheckOptions, type DnsCheckResult } from './customDomain.service.js';

const DUPLICATE_KEY = 11000;
/** Repeated verify clicks within this window share one job. */
export const VERIFY_DEDUP_TTL_MS = 30_000;
export const AUDIT_CONCURRENCY = 5;

export interface DomainCheckOutcome {
  domainId: string;
  status: CustomDomainStatus;
  /** False when the owner replaced the domain while the lookup ran, so nothing was written. */
  applied: boolean;
  check: DnsCheckResult;
}

type CheckedDomain = Pick<ICustomDomain, 'domain' | 'verificationToken' | 'status' | 'userId'> & { _id: unknown };
type DomainUpdate = Partial<Pick<ICustomDomain, 'status' | 'verifiedAt' | 'lastCheckedAt' | 'suspendedAt' | 'lastError'>>;

function nextState(doc: CheckedDomain, check: DnsCheckResult, now: Date): DomainUpdate {
  if (check.verified) {
    return { status: 'active', verifiedAt: now, lastCheckedAt: now, suspendedAt: null, lastError: null };
  }
  if (doc.status === 'active') {
    return check.transient
      ? { lastCheckedAt: now, lastError: check.error }
      : { status: 'suspended', suspendedAt: now, lastCheckedAt: now, lastError: check.error };
  }
  return { status: 'failed', lastCheckedAt: now, lastError: check.error };
}

async function applyCheck(doc: CheckedDomain, options: DnsCheckOptions): Promise<DomainCheckOutcome> {
  const domainId = String(doc._id);
  const check = await checkDomainRecords(doc.domain, doc.verificationToken, options);
  let update = nextState(doc, check, new Date());
  // Matching on domain and token means a job queued before the owner switched domains changes nothing.
  const filter = { _id: doc._id, domain: doc.domain, verificationToken: doc.verificationToken };
  let matched: number;
  try {
    ({ matchedCount: matched } = await CustomDomain.updateOne(filter, { $set: update }));
  } catch (error) {
    if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
    // Another profile activated this domain first (unique index on active domains).
    update = {
      status: 'failed',
      lastCheckedAt: update.lastCheckedAt,
      lastError: { code: 'DOMAIN_TAKEN', message: `${doc.domain} is already connected to another DevTrack profile` },
    };
    ({ matchedCount: matched } = await CustomDomain.updateOne(filter, { $set: update }));
  }

  const status = update.status ?? doc.status;
  if (matched > 0 && status !== doc.status) {
    const details = {
      event: `custom_domain_${status}`, domainId, userId: String(doc.userId), from: doc.status, reason: update.lastError?.code,
    };
    if (status === 'suspended') logger.warn('[custom-domain] Domain suspended, DNS records are gone', details);
    else logger.info('[custom-domain] Domain status changed', details);
  }
  return { domainId, status, applied: matched > 0, check };
}

/** Job handler for verify_custom_domain. Returns null when the domain was deleted meanwhile. */
export async function verifyCustomDomain(domainId: string, options: DnsCheckOptions = {}): Promise<DomainCheckOutcome | null> {
  const doc = await CustomDomain.findById(domainId).select('domain verificationToken status userId').lean();
  if (!doc) return null;
  return applyCheck(doc, options);
}

export interface CustomDomainAuditSummary {
  checked: number;
  active: number;
  suspended: number;
  /** Lookups that timed out or errored; those domains stay active until a definitive answer. */
  inconclusive: number;
  errors: number;
}

/** Job handler for audit_custom_domains: re-checks every active domain, a few at a time. */
export async function auditCustomDomains(options: DnsCheckOptions & { concurrency?: number } = {}): Promise<CustomDomainAuditSummary> {
  const summary: CustomDomainAuditSummary = { checked: 0, active: 0, suspended: 0, inconclusive: 0, errors: 0 };
  const startedAt = new Date();
  // Each check moves lastCheckedAt past startedAt, so the cursor cannot meet the same domain twice.
  const cursor = CustomDomain.find({ status: 'active', lastCheckedAt: { $not: { $gte: startedAt } } })
    .sort({ lastCheckedAt: 1 })
    .select('domain verificationToken status userId')
    .lean()
    .cursor();
  const running = new Set<Promise<void>>();

  for await (const doc of cursor) {
    const task = applyCheck(doc, options).then(
      outcome => {
        summary.checked++;
        if (outcome.status === 'suspended') summary.suspended++;
        else if (outcome.status === 'active') {
          summary.active++;
          if (!outcome.check.verified) summary.inconclusive++;
        }
      },
      error => {
        summary.errors++;
        logger.error('[custom-domain] Re-check failed', error, { event: 'custom_domain_audit_failed', domainId: String(doc._id) });
      },
    ).finally(() => running.delete(task));
    running.add(task);
    if (running.size >= (options.concurrency ?? AUDIT_CONCURRENCY)) await Promise.race(running);
  }
  await Promise.all(running);

  logger.info('[custom-domain] Weekly re-check finished', { event: 'custom_domain_audit_complete', ...summary });
  return summary;
}

/** Queues an immediate verification on the maintenance queue. */
export async function enqueueCustomDomainVerification(domainId: string): Promise<void> {
  const data: SystemMaintenanceJobData = { task: 'verify_custom_domain', domainId };
  await getSystemMaintenanceQueue().add('verify-custom-domain', data, {
    attempts: 1,
    deduplication: { id: `custom-domain-verify:${domainId}`, ttl: VERIFY_DEDUP_TTL_MS },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  });
}
