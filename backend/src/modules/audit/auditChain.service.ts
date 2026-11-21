// src/modules/audit/auditChain.service.ts — tamper-evident hash chain for audit records.
//
// Every record carries the hash of the one before it:
//   recordHash = sha256(sequenceNumber | previousHash | timestamp | userId | eventType | payloadHash)
// Changing, removing or inserting a record breaks the chain at a specific sequence number, which
// verifyAuditChain reports. This module is pure (no database), so the model hook and the sweep job
// can both build on it.
import { createHash } from 'node:crypto';

/** previousHash of the first record in a chain. */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditChainFields {
  sequenceNumber: number;
  previousHash: string;
  /** ISO 8601 timestamp of the record. */
  timestamp: string;
  userId: string;
  eventType: string;
  payloadHash: string;
  recordHash: string;
}

export interface AuditInput {
  timestamp: Date | string;
  userId: string;
  eventType: string;
  payload: unknown;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** JSON with sorted keys, so the same payload always hashes the same regardless of property order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function hashPayload(payload: unknown): string {
  return sha256(canonicalize(payload));
}

export function computeRecordHash(f: Omit<AuditChainFields, 'recordHash'>): string {
  // The separator is a character that cannot appear in a hex hash, an ISO date or a sequence number.
  return sha256([f.sequenceNumber, f.previousHash, f.timestamp, f.userId, f.eventType, f.payloadHash].join('|'));
}

/** Builds the chain fields for the next record. `prev` is the current tail, or null for an empty chain. */
export function chainNext(prev: Pick<AuditChainFields, 'sequenceNumber' | 'recordHash'> | null, input: AuditInput): AuditChainFields {
  const fields = {
    sequenceNumber: prev ? prev.sequenceNumber + 1 : 1,
    previousHash: prev ? prev.recordHash : GENESIS_HASH,
    timestamp: input.timestamp instanceof Date ? input.timestamp.toISOString() : input.timestamp,
    userId: input.userId,
    eventType: input.eventType,
    payloadHash: hashPayload(input.payload),
  };
  return { ...fields, recordHash: computeRecordHash(fields) };
}

export type AuditFailureReason = 'hash_mismatch' | 'previous_hash_mismatch' | 'sequence_gap' | 'duplicate_or_out_of_order';

export interface AuditVerification {
  ok: boolean;
  checked: number;
  /** Sequence number of the first record that failed. For a deleted record this is the one after the gap. */
  brokenAt?: number;
  reason?: AuditFailureReason;
}

/**
 * Walks records in order and recomputes every hash.
 * @param records   records to check, in any order (sorted by sequenceNumber here)
 * @param anchor    recordHash of the record just before the first one given. Leave unset when the slice starts at the
 *                  chain's beginning (sequence 1), where GENESIS_HASH is expected.
 */
export function verifyAuditChain(records: AuditChainFields[], anchor?: { sequenceNumber: number; recordHash: string }): AuditVerification {
  const sorted = [...records].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  let expectedSeq = anchor ? anchor.sequenceNumber + 1 : sorted.length ? sorted[0].sequenceNumber : 1;
  let expectedPrev = anchor ? anchor.recordHash : GENESIS_HASH;
  if (!anchor && sorted.length && sorted[0].sequenceNumber !== 1) {
    // A slice from the middle with no anchor cannot be tied to the rest of the chain, so only check links inside it.
    expectedPrev = sorted[0].previousHash;
  }

  let checked = 0;
  for (const rec of sorted) {
    if (rec.sequenceNumber < expectedSeq) return { ok: false, checked, brokenAt: rec.sequenceNumber, reason: 'duplicate_or_out_of_order' };
    if (rec.sequenceNumber > expectedSeq) return { ok: false, checked, brokenAt: rec.sequenceNumber, reason: 'sequence_gap' };
    if (rec.previousHash !== expectedPrev) return { ok: false, checked, brokenAt: rec.sequenceNumber, reason: 'previous_hash_mismatch' };
    if (computeRecordHash(rec) !== rec.recordHash) return { ok: false, checked, brokenAt: rec.sequenceNumber, reason: 'hash_mismatch' };
    expectedPrev = rec.recordHash;
    expectedSeq += 1;
    checked += 1;
  }
  return { ok: true, checked };
}

/** Binary Merkle root over record hashes, for the daily checkpoint. Empty input gives the genesis hash. */
export function merkleRoot(recordHashes: string[]): string {
  if (recordHashes.length === 0) return GENESIS_HASH;
  let level = [...recordHashes];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}
