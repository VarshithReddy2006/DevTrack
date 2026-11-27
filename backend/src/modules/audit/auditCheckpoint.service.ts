// src/modules/audit/auditCheckpoint.service.ts: signed daily checkpoints and integrity verification
// for the ProfileAuditLog hash chain.
//
// ProfileAuditLog has a 90 day TTL, so the start of the chain disappears over time.
// sealDailyCheckpoint stores a signed root per UTC day, and verifyAuditIntegrity starts from the
// oldest checkpoint whose records must still exist instead of from sequence 1.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AuditCheckpoint, type IAuditCheckpoint } from '../../db/models/auditCheckpoint.model.js';
import { PROFILE_AUDIT_TTL_SECONDS, ProfileAuditLog, type IProfileAuditLog } from '../../db/models/profileAuditLog.model.js';
import { logger } from '../../shared/logger.js';
import {
  canonicalize,
  GENESIS_HASH,
  merkleRoot,
  verifyAuditChain,
  type AuditChainFields,
  type AuditFailureReason,
} from './auditChain.service.js';
import { toAuditChainFields } from './auditLedger.service.js';

const DAY_MS = 86_400_000;
const BATCH = 500;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Rows that are part of the chain. Rows written before it have no sequence number. */
const CHAINED = { $type: 'number' as const };

interface Anchor {
  sequenceNumber: number;
  recordHash: string;
}

// ─── Checkpoints ────────────────────────────────────────────────────────────

export function getCheckpointSecret(): string {
  const secret = process.env.AUDIT_CHECKPOINT_SECRET
    || (process.env.NODE_ENV === 'production' ? undefined : 'devtrack-local-audit-checkpoint-secret');
  if (!secret) throw new Error('AUDIT_CHECKPOINT_SECRET is required in production');
  return secret;
}

type CheckpointFields = Pick<IAuditCheckpoint,
  'day' | 'fromSequence' | 'toSequence' | 'recordCount' | 'anchorHash' | 'lastRecordHash' | 'merkleRoot' | 'previousCheckpointHash'>;

function checkpointHashOf(cp: CheckpointFields): string {
  const { day, fromSequence, toSequence, recordCount, anchorHash, lastRecordHash, merkleRoot: root, previousCheckpointHash } = cp;
  return createHash('sha256')
    .update(canonicalize({ day, fromSequence, toSequence, recordCount, anchorHash, lastRecordHash, merkleRoot: root, previousCheckpointHash }))
    .digest('hex');
}

const sign = (checkpointHash: string, secret: string) => createHmac('sha256', secret).update(checkpointHash).digest('hex');

function signatureMatches(cp: Pick<IAuditCheckpoint, 'checkpointHash' | 'signature'>, secret: string): boolean {
  const expected = Buffer.from(sign(cp.checkpointHash, secret));
  const actual = Buffer.from(cp.signature ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type CheckpointRow = CheckpointFields & Pick<IAuditCheckpoint, 'checkpointHash' | 'signature'>;

/** Checks every checkpoint's own hash and signature, and that each one continues the previous. */
function verifyCheckpointChain(checkpoints: CheckpointRow[], secret: string): { ok: true } | { ok: false; at: CheckpointRow } {
  let previous: CheckpointRow | undefined;
  for (const cp of checkpoints) {
    const linked = previous
      ? cp.previousCheckpointHash === previous.checkpointHash
        && cp.fromSequence === previous.toSequence + 1
        && cp.anchorHash === previous.lastRecordHash
      : cp.previousCheckpointHash === GENESIS_HASH;
    if (!linked || checkpointHashOf(cp) !== cp.checkpointHash || !signatureMatches(cp, secret)) return { ok: false, at: cp };
    previous = cp;
  }
  return { ok: true };
}

export class AuditChainBrokenError extends Error {
  constructor(readonly report: AuditIntegrityReport) {
    super(`ProfileAuditLog chain is broken at sequence ${report.brokenAt} (${report.reason})`);
    this.name = 'AuditChainBrokenError';
  }
}

const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/**
 * Seals one UTC day: the records from the previous checkpoint up to the last one created before
 * the day ended. The range is verified against the previous checkpoint first (the daily sweep
 * validator), so a broken chain is never sealed. Sealing the same day again returns the stored one.
 */
export async function sealDailyCheckpoint(day: string): Promise<IAuditCheckpoint> {
  if (!DAY_PATTERN.test(day) || Number.isNaN(dayStart(day))) throw new Error(`Invalid checkpoint day: ${day}`);
  const existing = await AuditCheckpoint.findOne({ day });
  if (existing) return existing;

  const secret = getCheckpointSecret();
  const previous = await AuditCheckpoint.findOne().sort({ toSequence: -1, day: -1 }).lean();
  if (previous && previous.day > day) throw new Error(`Cannot seal ${day}: ${previous.day} is already sealed`);
  // Never chain onto a checkpoint that was edited.
  if (previous && (checkpointHashOf(previous) !== previous.checkpointHash || !signatureMatches(previous, secret))) {
    throw new Error(`Checkpoint ${previous.day} does not match its hash or signature`);
  }

  const after = previous?.toSequence ?? 0;
  const last = await ProfileAuditLog.findOne({
    sequenceNumber: { ...CHAINED, $gt: after },
    createdAt: { $lt: new Date(dayStart(day) + DAY_MS) },
  }).sort({ sequenceNumber: -1 }).select('sequenceNumber').lean();
  const toSequence = last?.sequenceNumber ?? after;

  let anchor: Anchor | undefined = previous ? { sequenceNumber: previous.toSequence, recordHash: previous.lastRecordHash } : undefined;
  if (!anchor) {
    const first = await ProfileAuditLog.findOne({ sequenceNumber: CHAINED }).sort({ sequenceNumber: 1 }).lean();
    if (!first || first.sequenceNumber === 1) {
      anchor = { sequenceNumber: 0, recordHash: GENESIS_HASH };
    } else {
      // The chain started before the first checkpoint and its head already expired.
      logger.warn('[audit] First checkpoint starts after the chain head expired', { firstSequence: first.sequenceNumber });
      anchor = { sequenceNumber: first.sequenceNumber! - 1, recordHash: first.previousHash! };
    }
  }

  const hashes: string[] = [];
  const result = await walkChain(anchor.sequenceNumber + 1, toSequence, anchor, rec => { hashes.push(rec.recordHash); });
  if (!result.ok) {
    const report: AuditIntegrityReport = {
      ok: false, fromSequence: anchor.sequenceNumber + 1, toSequence, checked: result.checked, checkpointsChecked: 0,
      anchoredBy: 'checkpoint', brokenAt: result.brokenAt, reason: result.reason,
    };
    logger.error('[audit] Refusing to seal a broken chain', { day, ...report });
    throw new AuditChainBrokenError(report);
  }

  const fields: CheckpointFields = {
    day,
    fromSequence: anchor.sequenceNumber + 1,
    toSequence,
    recordCount: hashes.length,
    anchorHash: anchor.recordHash,
    lastRecordHash: hashes.at(-1) ?? anchor.recordHash,
    merkleRoot: merkleRoot(hashes),
    previousCheckpointHash: previous?.checkpointHash ?? GENESIS_HASH,
  };
  const checkpointHash = checkpointHashOf(fields);
  try {
    return await AuditCheckpoint.create({ ...fields, checkpointHash, signature: sign(checkpointHash, secret) });
  } catch (error) {
    // Another instance sealed the same day first.
    const sealed = (error as { code?: number }).code === 11000 ? await AuditCheckpoint.findOne({ day }) : null;
    if (sealed) return sealed;
    throw error;
  }
}

// ─── Verification ───────────────────────────────────────────────────────────

export type AuditIntegrityFailure = AuditFailureReason | 'checkpoint_tampered' | 'checkpoint_mismatch' | 'records_missing';

export interface AuditIntegrityReport {
  ok: boolean;
  fromSequence: number;
  toSequence: number;
  /** Records whose hash and link were recomputed. */
  checked: number;
  /** Checkpoints whose range was compared with the records. */
  checkpointsChecked: number;
  /** What the first record was checked against. `none` means only links inside the range were checked. */
  anchoredBy: 'genesis' | 'checkpoint' | 'record' | 'none';
  brokenAt?: number;
  reason?: AuditIntegrityFailure;
  checkpointDay?: string;
}

/**
 * Streams records `from..to` in sequence order and verifies them in batches. `onRecord` sees each
 * record after its batch passed and may stop the walk by returning a failure.
 */
async function walkChain(
  from: number,
  to: number,
  anchor: Anchor | undefined,
  onRecord?: (rec: AuditChainFields) => { brokenAt: number; reason: AuditIntegrityFailure } | void,
): Promise<{ ok: boolean; checked: number; brokenAt?: number; reason?: AuditIntegrityFailure }> {
  if (to < from) return { ok: true, checked: 0 };
  const cursor = ProfileAuditLog.find({ sequenceNumber: { ...CHAINED, $gte: from, $lte: to } })
    .sort({ sequenceNumber: 1 })
    .lean<IProfileAuditLog[]>()
    .cursor({ batchSize: BATCH });

  let checked = 0;
  let link = anchor;
  let batch: AuditChainFields[] = [];
  const flush = () => {
    const result = verifyAuditChain(batch, link);
    checked += result.checked;
    if (!result.ok) return { ok: false, checked, brokenAt: result.brokenAt, reason: result.reason };
    for (const rec of batch) {
      const failure = onRecord?.(rec);
      if (failure) return { ok: false, checked, ...failure };
    }
    const tail = batch.at(-1);
    if (tail) link = { sequenceNumber: tail.sequenceNumber, recordHash: tail.recordHash };
    batch = [];
    return null;
  };
  try {
    for await (const row of cursor) {
      batch.push(toAuditChainFields(row));
      if (batch.length >= BATCH) {
        const failed = flush();
        if (failed) return failed;
      }
    }
    return flush() ?? { ok: true, checked };
  } finally {
    await cursor.close();
  }
}

async function recordAnchor(sequenceNumber: number): Promise<Anchor | undefined> {
  const row = await ProfileAuditLog.findOne({ sequenceNumber }).select('sequenceNumber recordHash').lean();
  return row?.recordHash ? { sequenceNumber, recordHash: row.recordHash } : undefined;
}

/**
 * Recomputes the chain and reports the first broken sequence number.
 *
 * With no range it checks everything that must still exist: it starts at the oldest checkpoint
 * whose day is inside the TTL window (records before that may have expired) and runs to the
 * newest record. A checkpoint whose records are gone, edited or rewritten is reported too.
 * With `fromSeq` it starts there, anchored on sequence 1, a checkpoint ending just before it, or
 * the stored record just before it.
 */
export async function verifyAuditIntegrity(fromSeq?: number, toSeq?: number, now = new Date()): Promise<AuditIntegrityReport> {
  const secret = getCheckpointSecret();
  const checkpoints = await AuditCheckpoint.find().sort({ toSequence: 1, day: 1 }).lean<CheckpointRow[]>();
  const chainCheck = verifyCheckpointChain(checkpoints, secret);
  if (!chainCheck.ok) {
    return {
      ok: false, fromSequence: chainCheck.at.fromSequence, toSequence: chainCheck.at.toSequence, checked: 0, checkpointsChecked: 0,
      anchoredBy: 'checkpoint', brokenAt: chainCheck.at.fromSequence, reason: 'checkpoint_tampered', checkpointDay: chainCheck.at.day,
    };
  }

  const newest = await ProfileAuditLog.findOne({ sequenceNumber: CHAINED }).sort({ sequenceNumber: -1 }).select('sequenceNumber').lean();
  const end = Math.min(toSeq ?? Number.MAX_SAFE_INTEGER, newest?.sequenceNumber ?? 0);
  const lastSealed = checkpoints.at(-1);

  let start: number;
  let anchor: Anchor | undefined;
  let anchoredBy: AuditIntegrityReport['anchoredBy'];
  if (fromSeq !== undefined && fromSeq > 1) {
    start = fromSeq;
    const sealed = checkpoints.find(cp => cp.toSequence === fromSeq - 1);
    anchor = sealed ? { sequenceNumber: sealed.toSequence, recordHash: sealed.lastRecordHash } : await recordAnchor(fromSeq - 1);
    anchoredBy = sealed ? 'checkpoint' : anchor ? 'record' : 'none';
  } else if (fromSeq !== undefined) {
    start = 1;
    anchor = { sequenceNumber: 0, recordHash: GENESIS_HASH };
    anchoredBy = 'genesis';
  } else {
    const horizon = now.getTime() - PROFILE_AUDIT_TTL_SECONDS * 1000 + DAY_MS;
    const retained = checkpoints.find(cp => dayStart(cp.day) >= horizon);
    if (retained) {
      start = retained.fromSequence;
      anchor = { sequenceNumber: start - 1, recordHash: retained.anchorHash };
      // Records of a sealed day inside the TTL window cannot have expired yet.
      if (lastSealed && end < lastSealed.toSequence) {
        return {
          ok: false, fromSequence: start, toSequence: end, checked: 0, checkpointsChecked: 0, anchoredBy: 'checkpoint',
          brokenAt: end + 1, reason: 'records_missing',
        };
      }
    } else if (lastSealed) {
      start = lastSealed.toSequence + 1;
      anchor = { sequenceNumber: lastSealed.toSequence, recordHash: lastSealed.lastRecordHash };
    } else {
      const oldest = await ProfileAuditLog.findOne({ sequenceNumber: CHAINED }).sort({ sequenceNumber: 1 }).select('sequenceNumber').lean();
      start = oldest?.sequenceNumber ?? 1;
      anchor = start === 1 ? { sequenceNumber: 0, recordHash: GENESIS_HASH } : undefined;
    }
    anchoredBy = !anchor ? 'none' : anchor.sequenceNumber === 0 ? 'genesis' : 'checkpoint';
  }

  // Checkpoints fully inside the walked range: their root and boundary hash must match the records.
  const covered = checkpoints.filter(cp => cp.recordCount > 0 && cp.fromSequence >= start && cp.toSequence <= end);
  let next = 0;
  let hashes: string[] = [];
  const result = await walkChain(start, end, anchor, rec => {
    const cp = covered[next];
    if (!cp || rec.sequenceNumber < cp.fromSequence) return;
    hashes.push(rec.recordHash);
    if (rec.sequenceNumber < cp.toSequence) return;
    next += 1;
    const root = merkleRoot(hashes);
    hashes = [];
    if (root !== cp.merkleRoot || rec.recordHash !== cp.lastRecordHash) {
      return { brokenAt: cp.fromSequence, reason: 'checkpoint_mismatch' };
    }
  });

  const report: AuditIntegrityReport = {
    ok: result.ok, fromSequence: start, toSequence: end, checked: result.checked, checkpointsChecked: next, anchoredBy,
  };
  if (!result.ok) {
    report.brokenAt = result.brokenAt;
    report.reason = result.reason;
    const cp = checkpoints.find(c => result.brokenAt !== undefined && c.fromSequence <= result.brokenAt && result.brokenAt <= c.toSequence);
    if (cp) report.checkpointDay = cp.day;
  }
  return report;
}

/**
 * Daily maintenance task: seal yesterday (UTC), then verify everything still inside the TTL
 * window. A broken chain fails the job so it shows up in the failed-job list and the DLQ.
 */
export async function runDailyAuditCheckpoint(now = new Date()): Promise<{ checkpoint: IAuditCheckpoint; report: AuditIntegrityReport }> {
  const day = new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10);
  const checkpoint = await sealDailyCheckpoint(day);
  const report = await verifyAuditIntegrity(undefined, undefined, now);
  if (!report.ok) {
    logger.error('[audit] ProfileAuditLog integrity check failed', report);
    throw new AuditChainBrokenError(report);
  }
  logger.info('[audit] ProfileAuditLog checkpoint sealed and chain verified', {
    day, toSequence: checkpoint.toSequence, records: checkpoint.recordCount, checked: report.checked,
  });
  return { checkpoint, report };
}
