// src/modules/audit/auditLedger.service.ts — DB-backed crypto-shredded & hash-chained audit ledger.
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Types, type ClientSession } from 'mongoose';
import { AuditCheckpoint } from '../../db/models/auditCheckpoint.model.js';
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
  hashPayload,
  inspectAuditChain,
  pseudonymizeAuditSubject,
  verifyAuditChain,
  type AuditChainFields,
  type AuditChainInspection,
  type AuditVerification,
} from './auditChain.service.js';

/** Appends racing for the same position outside a transaction re-read the tail this many times. */
const APPEND_ATTEMPTS = 100;

export interface AppendChainedAuditInput {
  /** Fixed id for writers that must not log the same thing twice (the daily sweep). */
  _id?: Types.ObjectId;
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
 * Everything stored on a row besides the chain columns, as hashed into `payloadHash`. Verification
 * rebuilds it from the stored row, so editing any of these fields is detected. A tombstone's
 * payload is its details, matching chainErasureTombstone.
 */
function sealedPayload(
  row: Pick<
    IProfileAuditLog,
    'eventType' | 'userId' | 'triggeredBy' | 'details' | 'encryptedDetails' | 'suspicionScoreBefore' | 'suspicionScoreAfter' | 'createdAt'
  >
): unknown {
  if (row.eventType === ACCOUNT_ERASURE_TOMBSTONE) return row.details;
  const sealed = row.encryptedDetails;
  return {
    userId: row.userId ? String(row.userId) : null,
    triggeredBy: row.triggeredBy,
    details: row.details,
    encryptedDetails: sealed
      ? { algorithm: sealed.algorithm, iv: sealed.iv, authTag: sealed.authTag, ciphertext: sealed.ciphertext }
      : null,
    suspicionScoreBefore: row.suspicionScoreBefore ?? null,
    suspicionScoreAfter: row.suspicionScoreAfter ?? null,
    createdAt: row.createdAt,
  };
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

  let doc: Pick<IAuditEncryptionKey, 'userId' | 'keyHex' | 'saltHex'> | null = null;
  try {
    doc = await AuditEncryptionKey.findOneAndUpdate(
      { userId: userObjectId },
      { $setOnInsert: { userId: userObjectId, keyHex, saltHex } },
      { upsert: true, new: true, ...(session ? { session } : {}) }
    ).lean();
  } catch (err: any) {
    if (!session && err?.code === 11000) {
      doc = await AuditEncryptionKey.findOne({ userId: userObjectId }).lean();
    } else {
      throw err;
    }
  }

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

  if (tail && typeof tail.sequenceNumber === 'number' && tail.recordHash) {
    return { sequenceNumber: tail.sequenceNumber, recordHash: tail.recordHash };
  }
  // Every row can expire after a long quiet period; the newest checkpoint still knows where the chain ended.
  const sealed = await AuditCheckpoint.findOne(
    {},
    { toSequence: 1, lastRecordHash: 1 },
    session ? { session } : undefined
  )
    .sort({ toSequence: -1 })
    .lean();
  return sealed && sealed.toSequence > 0
    ? { sequenceNumber: sealed.toSequence, recordHash: sealed.lastRecordHash }
    : null;
}

/**
 * Reads the tail and inserts the next link. Two writers that read the same tail collide on the
 * unique sequence index. In a transaction that is a transient write conflict which
 * `withTransaction` retries on the new tail, so this only loops outside one.
 */
async function appendToTail(
  session: ClientSession | null | undefined,
  insert: (tail: Awaited<ReturnType<typeof readChainTail>>) => Promise<IProfileAuditLog>,
  fixedId?: Types.ObjectId
): Promise<IProfileAuditLog> {
  const attempts = session?.inTransaction() ? 1 : APPEND_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    if (fixedId) {
      const existing = await ProfileAuditLog.findById(fixedId, null, session ? { session } : undefined);
      if (existing) return existing;
    }
    try {
      return await insert(await readChainTail(session));
    } catch (err: any) {
      const lostRace = isDuplicateSequenceError(err) || (!!fixedId && err?.code === 11000);
      if (attempt >= attempts || !lostRace) throw err;
      await delay(Math.random() * Math.min(attempt, 20));
    }
  }
}

/**
 * Appends an immutable, hash-chained audit entry whose PII payload is encrypted
 * with the user's crypto-shredding key. Neither plaintext userId nor plaintext details
 * are stored on the immutable ledger record. Pass the caller's session to write inside its
 * transaction; with a fixed `_id` an existing row with that id is returned unchanged.
 */
export async function appendChainedAuditEvent(
  input: AppendChainedAuditInput,
  session?: ClientSession | null
): Promise<IProfileAuditLog> {
  const keyDoc = await getOrCreateAuditKey(input.userId, session);
  const subjectHash = pseudonymizeAuditSubject(String(input.userId), keyDoc.saltHex);
  // JSON round trip, so ObjectIds and dates are encrypted as strings and undefined keys are dropped.
  const encryptedDetails = encryptAuditPayload(JSON.parse(JSON.stringify(input.details)), keyDoc.keyHex);
  const timestamp = input.timestamp ?? new Date();
  const sessionOpts = session ? { session } : {};

  return appendToTail(session, async (tail) => {
    const row = {
      ...(input._id ? { _id: input._id } : {}),
      userId: null,
      subjectHash,
      eventType: input.eventType,
      triggeredBy: input.triggeredBy,
      details: { encrypted: true },
      encryptedDetails,
      suspicionScoreBefore: input.suspicionScoreBefore ?? null,
      suspicionScoreAfter: input.suspicionScoreAfter ?? null,
      createdAt: new Date(),
    };
    const chain = chainNext(tail, {
      timestamp,
      userId: subjectHash,
      eventType: input.eventType,
      payload: sealedPayload(row),
    });
    const [created] = await ProfileAuditLog.create(
      [
        {
          ...row,
          sequenceNumber: chain.sequenceNumber,
          previousHash: chain.previousHash,
          chainTimestamp: chain.timestamp,
          payloadHash: chain.payloadHash,
          recordHash: chain.recordHash,
        },
      ],
      sessionOpts
    );
    return created;
  }, input._id);
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
 * Filter for every ledger row about one user: rows stored with a plain userId, and
 * chained rows, which only carry the salted subject hash.
 */
export async function auditRowsFor(
  userId: Types.ObjectId,
  session?: ClientSession | null
): Promise<{ $or: Array<{ userId: Types.ObjectId } | { subjectHash: string }> }> {
  const key = await AuditEncryptionKey.findOne({ userId }, null, session ? { session } : undefined).lean();
  return {
    $or: [{ userId }, ...(key ? [{ subjectHash: pseudonymizeAuditSubject(String(userId), key.saltHex) }] : [])],
  };
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

  return appendToTail(session, async (tail) => {
    const chain = chainErasureTombstone(tail, {
      timestamp: erasedAt,
      subjectRef,
      keyDestroyed: input.keyDestroyed,
      reason,
    });
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
  });
}

/**
 * Maps a stored ProfileAuditLog document to pure AuditChainFields for verification. The payload
 * hash is recomputed from the stored fields, never read back.
 */
export function toAuditChainFields(
  doc: Pick<
    IProfileAuditLog,
    | 'sequenceNumber' | 'previousHash' | 'chainTimestamp' | 'subjectHash' | 'userId' | 'eventType' | 'recordHash'
    | 'triggeredBy' | 'details' | 'encryptedDetails' | 'suspicionScoreBefore' | 'suspicionScoreAfter' | 'createdAt'
  >
): AuditChainFields {
  return {
    sequenceNumber: doc.sequenceNumber!,
    previousHash: doc.previousHash!,
    timestamp: doc.chainTimestamp!,
    userId: doc.subjectHash ?? (doc.userId ? String(doc.userId) : 'system'),
    eventType: doc.eventType,
    payloadHash: hashPayload(sealedPayload(doc)),
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
