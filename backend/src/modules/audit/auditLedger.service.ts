// src/modules/audit/auditLedger.service.ts — DB-backed crypto-shredded & hash-chained audit ledger.
import { createHash, randomBytes } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import {
  AuditEncryptionKey,
  ProfileAuditLog,
  type IAuditEncryptionKey,
  type IProfileAuditLog,
  type ProfileAuditEventType,
} from '../../db/models/profileAuditLog.model.js';
import {
  ACCOUNT_ERASURE_TOMBSTONE,
  chainErasureTombstone,
  chainNext,
  decryptAuditPayload,
  encryptAuditPayload,
  inspectAuditChain,
  pseudonymizeAuditSubject,
  verifyAuditChain,
  type AuditChainFields,
  type AuditChainInspection,
  type AuditVerification,
} from './auditChain.service.js';

export interface AppendChainedAuditInput {
  userId: string | Types.ObjectId;
  eventType: Exclude<ProfileAuditEventType, 'ACCOUNT_ERASURE_TOMBSTONE'>;
  triggeredBy: 'system' | 'admin' | 'user';
  details: Record<string, unknown>;
  suspicionScoreBefore?: number | null;
  suspicionScoreAfter?: number | null;
  timestamp?: Date;
}

export interface AppendErasureTombstoneInput {
  userId: string;
  subjectRef?: string | null;
  keyDestroyed: boolean;
  reason?: string;
  erasedAt?: Date;
}

function isDuplicateSequenceError(err: any): boolean {
  return err?.code === 11000 && (err?.keyPattern?.sequenceNumber || String(err?.message).includes('sequenceNumber'));
}

/**
 * Fetches or atomically provisions a user's ephemeral AES-256 key and pseudonymization salt.
 */
export async function getOrCreateAuditKey(
  userId: string | Types.ObjectId,
  session?: ClientSession | null
): Promise<Pick<IAuditEncryptionKey, 'userId' | 'keyHex' | 'saltHex'>> {
  const userObjectId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
  const keyHex = randomBytes(32).toString('hex');
  const saltHex = randomBytes(32).toString('hex');

  const doc = await AuditEncryptionKey.findOneAndUpdate(
    { userId: userObjectId },
    { $setOnInsert: { userId: userObjectId, keyHex, saltHex } },
    { upsert: true, new: true, ...(session ? { session } : {}) }
  ).lean();

  if (!doc) {
    throw new Error('Failed to provision audit encryption key');
  }
  return doc;
}

/**
 * Permanently shreds the user's encryption key and salt from the key store.
 * Returns the pre-destruction subjectHash (if a key existed) and the count of destroyed keys.
 */
export async function destroyAuditKey(
  userId: string | Types.ObjectId,
  session?: ClientSession | null
): Promise<{ shreddedCount: number; subjectHash: string | null }> {
  const userObjectId =
    typeof userId === 'string'
      ? Types.ObjectId.isValid(userId)
        ? new Types.ObjectId(userId)
        : null
      : userId;
  if (!userObjectId) {
    return { shreddedCount: 0, subjectHash: null };
  }

  const sessionOpts = session ? { session } : {};
  const existing = await AuditEncryptionKey.findOne({ userId: userObjectId }, null, sessionOpts).lean();
  if (!existing) {
    return { shreddedCount: 0, subjectHash: null };
  }

  const subjectHash = pseudonymizeAuditSubject(String(userObjectId), existing.saltHex);
  const res = await AuditEncryptionKey.deleteOne({ userId: userObjectId }, sessionOpts);
  return { shreddedCount: res.deletedCount ?? 0, subjectHash };
}

async function readChainTail(
  session?: ClientSession | null
): Promise<Pick<AuditChainFields, 'sequenceNumber' | 'recordHash'> | null> {
  const tail = await ProfileAuditLog.findOne(
    { sequenceNumber: { $type: 'number' } },
    { sequenceNumber: 1, recordHash: 1 },
    session ? { session } : undefined
  )
    .sort({ sequenceNumber: -1 })
    .lean();

  if (!tail || typeof tail.sequenceNumber !== 'number' || !tail.recordHash) {
    return null;
  }
  return { sequenceNumber: tail.sequenceNumber, recordHash: tail.recordHash };
}

/**
 * Appends an immutable, hash-chained audit entry whose PII payload is encrypted
 * with the user's crypto-shredding key. Neither plaintext userId nor plaintext details
 * are stored on the immutable ledger record.
 */
export async function appendChainedAuditEvent(
  input: AppendChainedAuditInput,
  session?: ClientSession | null
): Promise<IProfileAuditLog> {
  const keyDoc = await getOrCreateAuditKey(input.userId, session);
  const subjectHash = pseudonymizeAuditSubject(String(input.userId), keyDoc.saltHex);
  const encryptedDetails = encryptAuditPayload(input.details, keyDoc.keyHex);
  const timestamp = input.timestamp ?? new Date();
  const sessionOpts = session ? { session } : {};

  for (let attempt = 0; attempt < 3; attempt++) {
    const tail = await readChainTail(session);
    const chain = chainNext(tail, {
      timestamp,
      userId: subjectHash,
      eventType: input.eventType,
      payload: encryptedDetails,
    });

    try {
      const [created] = await ProfileAuditLog.create(
        [
          {
            userId: null,
            subjectHash,
            eventType: input.eventType,
            triggeredBy: input.triggeredBy,
            details: { encrypted: true },
            encryptedDetails,
            sequenceNumber: chain.sequenceNumber,
            previousHash: chain.previousHash,
            chainTimestamp: chain.timestamp,
            payloadHash: chain.payloadHash,
            recordHash: chain.recordHash,
            suspicionScoreBefore: input.suspicionScoreBefore ?? null,
            suspicionScoreAfter: input.suspicionScoreAfter ?? null,
          },
        ],
        sessionOpts
      );
      return created;
    } catch (err) {
      if (attempt < 2 && isDuplicateSequenceError(err)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Exhausted retries appending chained audit event');
}

/**
 * Attempts to decrypt an encrypted audit record for `userId`.
 * Returns `null` if the user's key has been crypto-shredded or does not match.
 */
export async function decryptChainedAuditEvent<T = Record<string, unknown>>(
  record: Pick<IProfileAuditLog, 'encryptedDetails' | 'subjectHash'>,
  userId: string | Types.ObjectId,
  session?: ClientSession | null
): Promise<T | null> {
  if (!record.encryptedDetails) return null;
  const userObjectId =
    typeof userId === 'string'
      ? Types.ObjectId.isValid(userId)
        ? new Types.ObjectId(userId)
        : null
      : userId;
  if (!userObjectId) return null;

  const keyDoc = await AuditEncryptionKey.findOne(
    { userId: userObjectId },
    null,
    session ? { session } : undefined
  ).lean();
  if (!keyDoc) return null;

  if (record.subjectHash && pseudonymizeAuditSubject(String(userObjectId), keyDoc.saltHex) !== record.subjectHash) {
    return null;
  }

  try {
    return decryptAuditPayload<T>(record.encryptedDetails, keyDoc.keyHex);
  } catch {
    return null;
  }
}

/**
 * Appends an immutable ACCOUNT_ERASURE_TOMBSTONE record to the hash chain without
 * mutating any historical audit log records.
 */
export async function appendErasureTombstone(
  input: AppendErasureTombstoneInput,
  session?: ClientSession | null
): Promise<IProfileAuditLog> {
  const erasedAt = input.erasedAt ?? new Date();
  const subjectRef =
    input.subjectRef ??
    createHash('sha256').update(`erased:${input.userId}:${erasedAt.toISOString()}`).digest('hex');
  const reason = input.reason ?? 'gdpr_right_to_erasure';
  const sessionOpts = session ? { session } : {};

  for (let attempt = 0; attempt < 3; attempt++) {
    const tail = await readChainTail(session);
    const chain = chainErasureTombstone(tail, {
      timestamp: erasedAt,
      subjectRef,
      keyDestroyed: input.keyDestroyed,
      reason,
    });

    try {
      const [created] = await ProfileAuditLog.create(
        [
          {
            userId: null,
            subjectHash: subjectRef,
            eventType: ACCOUNT_ERASURE_TOMBSTONE,
            triggeredBy: 'system',
            details: {
              subjectRef,
              keyDestroyed: input.keyDestroyed,
              reason,
              erasedAt: chain.timestamp,
            },
            encryptedDetails: null,
            sequenceNumber: chain.sequenceNumber,
            previousHash: chain.previousHash,
            chainTimestamp: chain.timestamp,
            payloadHash: chain.payloadHash,
            recordHash: chain.recordHash,
            suspicionScoreBefore: null,
            suspicionScoreAfter: null,
          },
        ],
        sessionOpts
      );
      return created;
    } catch (err) {
      if (attempt < 2 && isDuplicateSequenceError(err)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error('Exhausted retries appending erasure tombstone');
}

/** Maps a stored ProfileAuditLog document to pure AuditChainFields for verification. */
export function toAuditChainFields(
  doc: Pick<
    IProfileAuditLog,
    'sequenceNumber' | 'previousHash' | 'chainTimestamp' | 'subjectHash' | 'userId' | 'eventType' | 'payloadHash' | 'recordHash'
  >
): AuditChainFields {
  return {
    sequenceNumber: doc.sequenceNumber!,
    previousHash: doc.previousHash!,
    timestamp: doc.chainTimestamp!,
    userId: doc.subjectHash ?? (doc.userId ? String(doc.userId) : 'system'),
    eventType: doc.eventType,
    payloadHash: doc.payloadHash!,
    recordHash: doc.recordHash!,
  };
}

/** Loads all chained ProfileAuditLog records and runs verifyAuditChain across the full chain. */
export async function verifyStoredAuditChain(session?: ClientSession | null): Promise<AuditVerification> {
  const docs = await ProfileAuditLog.find(
    { sequenceNumber: { $type: 'number' } },
    null,
    session ? { session } : undefined
  )
    .sort({ sequenceNumber: 1 })
    .lean();

  return verifyAuditChain(docs.map(toAuditChainFields));
}

/** Loads all chained ProfileAuditLog records and returns verification + tombstone inspection summary. */
export async function inspectStoredAuditChain(session?: ClientSession | null): Promise<AuditChainInspection> {
  const docs = await ProfileAuditLog.find(
    { sequenceNumber: { $type: 'number' } },
    null,
    session ? { session } : undefined
  )
    .sort({ sequenceNumber: 1 })
    .lean();

  return inspectAuditChain(docs.map(toAuditChainFields));
}
