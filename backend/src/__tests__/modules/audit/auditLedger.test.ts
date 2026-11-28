import { createHmac } from 'node:crypto';
import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditCheckpoint } from '../../../db/models/auditCheckpoint.model.js';
import { AuditEncryptionKey, ProfileAuditLog } from '../../../db/models/profileAuditLog.model.js';
import { User } from '../../../db/models/user.model.js';
import { XpTransaction } from '../../../db/models/xpTransaction.model.js';
import { runInTransaction } from '../../../db/transaction.js';
import { chainNext, computeRecordHash, GENESIS_HASH, merkleRoot } from '../../../modules/audit/auditChain.service.js';
import {
  AuditChainBrokenError,
  runDailyAuditCheckpoint,
  sealDailyCheckpoint,
  verifyAuditIntegrity,
} from '../../../modules/audit/auditCheckpoint.service.js';
import {
  appendChainedAuditEvent,
  auditRowsFor,
  decryptChainedAuditEvent,
  toAuditChainFields,
  verifyStoredAuditChain,
} from '../../../modules/audit/auditLedger.service.js';
import { executeAccountErasure } from '../../../modules/privacy/accountErasure.worker.js';
import { AntiGamingWorker } from '../../../modules/profile/antiGaming.worker.js';
import { PublicationService } from '../../../modules/profile/publication.service.js';

const DAY = 86_400_000;
const SECRET = 'test-audit-checkpoint-secret';
const dayOf = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// The unique sequence index is what serializes concurrent writers, so make sure it is built.
beforeAll(async () => { await Promise.all([ProfileAuditLog.init(), AuditCheckpoint.init(), AuditEncryptionKey.init()]); });
beforeEach(() => { vi.stubEnv('AUDIT_CHECKPOINT_SECRET', SECRET); });
afterEach(() => { vi.unstubAllEnvs(); });

const owner = new Types.ObjectId();

const entry = (i = 0, userId = owner) => ({
  userId,
  eventType: i % 2 ? 'flag_raised' as const : 'anti_gaming_check' as const,
  triggeredBy: 'system' as const,
  details: { i, flags: i % 2 ? ['abnormal_xp_velocity'] : [] },
  suspicionScoreBefore: i,
  suspicionScoreAfter: i + 1,
});

async function appendMany(count: number) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(await appendChainedAuditEvent(entry(i)));
  return rows;
}

const raw = () => ProfileAuditLog.collection;
const bySeq = async (sequenceNumber: number) => (await ProfileAuditLog.findOne({ sequenceNumber }).lean())!;
const sequences = async () => (await ProfileAuditLog.find().sort({ sequenceNumber: 1 }).lean()).map(row => row.sequenceNumber);
const oneTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** Edits a row and gives it a recordHash that matches the new content, as someone covering their tracks would. */
async function forge(sequenceNumber: number, changes: Record<string, unknown>, previousHash?: string) {
  const row = { ...await bySeq(sequenceNumber), ...changes, ...(previousHash ? { previousHash } : {}) };
  const recordHash = computeRecordHash(toAuditChainFields(row));
  await raw().updateOne({ sequenceNumber }, { $set: { ...changes, previousHash: row.previousHash, recordHash } });
  return recordHash;
}

describe('appending to the chain', () => {
  it('links rows from genesis and stores ids and dates in a decryptable form', async () => {
    const decisionId = new Types.ObjectId();
    const first = await appendChainedAuditEvent({
      userId: owner, eventType: 'dossier_downloaded', triggeredBy: 'user',
      details: { downloadedAt: new Date('2026-11-20T10:00:00Z'), decisionId, userAgent: undefined },
    });
    await appendMany(4);

    expect(await decryptChainedAuditEvent(first, owner)).toEqual({ downloadedAt: '2026-11-20T10:00:00.000Z', decisionId: String(decisionId) });
    const rows = await ProfileAuditLog.find().sort({ sequenceNumber: 1 }).lean();
    expect(rows.map(row => row.sequenceNumber)).toEqual(oneTo(5));
    expect(rows[0].previousHash).toBe(GENESIS_HASH);
    for (let i = 1; i < rows.length; i++) expect(rows[i].previousHash).toBe(rows[i - 1].recordHash);
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: true, checked: 5, fromSequence: 1, toSequence: 5, anchoredBy: 'genesis' });
    expect(await verifyStoredAuditChain()).toEqual({ ok: true, checked: 5 });
  });

  it('keeps a single chain when many writers append at once', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => appendChainedAuditEvent(entry(i, i % 5 ? new Types.ObjectId() : owner))));
    expect(await sequences()).toEqual(oneTo(25));
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: true, checked: 25 });
  });

  it('keeps a single chain when callers append inside their own transactions', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => runInTransaction(
      session => appendChainedAuditEvent(entry(i, new Types.ObjectId()), session),
    )));
    expect(await sequences()).toEqual(oneTo(10));
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: true, checked: 10 });
  });

  it('returns the stored row for a repeated fixed id instead of logging twice', async () => {
    const _id = new Types.ObjectId();
    const [a, b] = await Promise.all([1, 2].map(() => appendChainedAuditEvent({ ...entry(), _id })));
    const again = await appendChainedAuditEvent({ ...entry(1), _id });
    expect([String(b._id), String(again._id)]).toEqual([String(a._id), String(a._id)]);
    expect(await ProfileAuditLog.countDocuments()).toBe(1);
  });

  it('commits and rolls back with the caller transaction', async () => {
    await expect(runInTransaction(async session => {
      await appendChainedAuditEvent(entry(), session);
      throw new Error('later step failed');
    })).rejects.toThrow('later step failed');
    expect(await ProfileAuditLog.countDocuments()).toBe(0);

    const row = await runInTransaction(session => appendChainedAuditEvent(entry(), session));
    expect(row).toMatchObject({ sequenceNumber: 1, previousHash: GENESIS_HASH });
  });

  it('adds well under 1 ms of hashing per write', () => {
    const payload = { triggeredBy: 'system', encryptedDetails: { ciphertext: 'a'.repeat(512) }, suspicionScoreBefore: 0, suspicionScoreAfter: 80 };
    let prev: ReturnType<typeof chainNext> | null = null;
    const runs = 2_000;
    const started = performance.now();
    for (let i = 0; i < runs; i++) {
      prev = chainNext(prev, { timestamp: new Date(), userId: String(owner), eventType: 'anti_gaming_check', payload });
    }
    expect((performance.now() - started) / runs).toBeLessThan(1);
  });
});

describe('existing writers', () => {
  it('put the sweep and publication entries on one chain without a plaintext user id', async () => {
    const users = await Promise.all([1, 2].map(async n => {
      const _id = new Types.ObjectId();
      return User.create({ _id, clerkId: `chain-${_id}`, email: `${_id}@example.test`, username: `chain${n}${String(_id).slice(-6)}`, displayName: 'Chain' });
    }));
    // One XP farmer, so the sweep writes a flag entry next to the daily checks.
    await XpTransaction.insertMany([1, 2, 3].map(minutesAgo => ({
      userId: users[0]._id, sourceType: 'challenge_completed', sourceId: `chain-${minutesAgo}`, xpAwarded: 1000,
      previousTotalXp: 0, newTotalXp: 1000, levelBefore: 1, levelAfter: 1, createdAt: new Date(Date.now() - minutesAgo * 60_000),
    })));
    const scheduledAt = new Date();
    await AntiGamingWorker.startAuditJob(scheduledAt);
    await AntiGamingWorker.startAuditJob(scheduledAt); // same day again: nothing new
    await PublicationService.publishProfile(users[1]._id, { slug: users[1].username, consentVersion: '2026-11', sections: { dsa: true } });
    await PublicationService.unpublishProfile(users[1]._id);

    const rows = await ProfileAuditLog.find().sort({ sequenceNumber: 1 }).lean();
    expect(rows.map(row => row.eventType).sort()).toEqual(['anti_gaming_check', 'anti_gaming_check', 'flag_raised', 'visibility_changed', 'visibility_changed']);
    expect(rows.map(row => row.sequenceNumber)).toEqual(oneTo(5));
    expect(rows.every(row => row.userId === null && row.encryptedDetails)).toBe(true);
    expect(await ProfileAuditLog.countDocuments(await auditRowsFor(users[0]._id))).toBe(2);
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: true, checked: 5 });
  });
});

describe('verifyAuditIntegrity', () => {
  it.each([
    ['ciphertext', { 'encryptedDetails.ciphertext': '00' }],
    ['actor', { triggeredBy: 'admin' }],
    ['score before', { suspicionScoreBefore: 0 }],
    ['score after', { suspicionScoreAfter: 0 }],
    ['plaintext details', { details: { encrypted: true, note: 'added' } }],
    ['user id', { userId: new Types.ObjectId() }],
    ['creation time', { createdAt: new Date(0) }],
    ['subject', { subjectHash: 'a'.repeat(64) }],
    ['event type', { eventType: 'flag_cleared' }],
  ])('pinpoints a record whose %s was edited directly in the database', async (_field, change) => {
    await appendMany(6);
    await raw().updateOne({ sequenceNumber: 4 }, { $set: change });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, brokenAt: 4, reason: 'hash_mismatch' });
    expect(await verifyStoredAuditChain()).toMatchObject({ ok: false, brokenAt: 4 });
  });

  it('catches an edit that also rewrote its own hash, because the next link breaks', async () => {
    await appendMany(10);
    await forge(4, { eventType: 'flag_cleared' });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, brokenAt: 5, reason: 'previous_hash_mismatch' });
  });

  it('detects a deleted record as a gap', async () => {
    await appendMany(10);
    await raw().deleteOne({ sequenceNumber: 7 });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, brokenAt: 8, reason: 'sequence_gap' });
  });

  it('detects a record inserted without the right link', async () => {
    await appendMany(5);
    await raw().insertOne({ ...await bySeq(5), _id: new Types.ObjectId(), sequenceNumber: 6, previousHash: GENESIS_HASH });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, brokenAt: 6, reason: 'previous_hash_mismatch' });
    // The unique index stops a second row at an existing position.
    await expect(raw().insertOne({ ...await bySeq(1), _id: new Types.ObjectId() })).rejects.toMatchObject({ code: 11000 });
  });

  it('verifies a range anchored on the record or checkpoint before it', async () => {
    await appendMany(4);
    await sealDailyCheckpoint(dayOf(0));
    await appendMany(6);
    expect(await verifyAuditIntegrity(5)).toMatchObject({ ok: true, anchoredBy: 'checkpoint', fromSequence: 5, toSequence: 10, checked: 6 });
    expect(await verifyAuditIntegrity(7, 9)).toMatchObject({ ok: true, anchoredBy: 'record', fromSequence: 7, toSequence: 9, checked: 3 });
    await raw().updateOne({ sequenceNumber: 8 }, { $set: { triggeredBy: 'admin' } });
    expect(await verifyAuditIntegrity(7, 9)).toMatchObject({ ok: false, brokenAt: 8, reason: 'hash_mismatch' });
    expect(await verifyAuditIntegrity(9)).toMatchObject({ ok: true, checked: 2 });
  });

  it('catches a chain rewritten consistently after it was sealed', async () => {
    await appendMany(6);
    const sealed = await sealDailyCheckpoint(dayOf(0));
    // Rewrite records 3..6 with a changed score and valid links: the chain alone looks fine.
    let previousHash = (await bySeq(2)).recordHash!;
    for (let seq = 3; seq <= 6; seq++) previousHash = await forge(seq, { suspicionScoreAfter: 0 }, previousHash);
    expect(await verifyStoredAuditChain()).toEqual({ ok: true, checked: 6 });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, reason: 'checkpoint_mismatch', brokenAt: 1, checkpointDay: sealed.day });
  });

  it('notices sealed records that disappeared from the end', async () => {
    await appendMany(5);
    await sealDailyCheckpoint(dayOf(0));
    await raw().deleteMany({ sequenceNumber: { $gte: 4 } });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, reason: 'records_missing', brokenAt: 4 });
  });

  it('still verifies after an account erasure, and checks the tombstone too', async () => {
    await appendMany(3);
    await sealDailyCheckpoint(dayOf(0));
    await executeAccountErasure(String(owner), { deleteClerkAccount: false, clearRedisCache: false });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: true, checked: 4 });
    await raw().updateOne({ sequenceNumber: 4 }, { $set: { 'details.reason': 'edited' } });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, brokenAt: 4, reason: 'hash_mismatch' });
  });
});

describe('daily checkpoints', () => {
  it('seals each day once, signed and linked to the previous day', async () => {
    const first = await appendMany(3);
    const day0 = await sealDailyCheckpoint(dayOf(0));
    expect(day0).toMatchObject({
      day: dayOf(0), fromSequence: 1, toSequence: 3, recordCount: 3,
      anchorHash: GENESIS_HASH, previousCheckpointHash: GENESIS_HASH,
      lastRecordHash: first[2].recordHash, merkleRoot: merkleRoot(first.map(row => row.recordHash!)),
    });
    expect(day0.signature).toBe(createHmac('sha256', SECRET).update(day0.checkpointHash).digest('hex'));
    expect(String((await sealDailyCheckpoint(dayOf(0)))._id)).toBe(String(day0._id));

    const second = await appendMany(2);
    const day1 = await sealDailyCheckpoint(dayOf(1));
    expect(day1).toMatchObject({
      fromSequence: 4, toSequence: 5, recordCount: 2,
      anchorHash: day0.lastRecordHash, previousCheckpointHash: day0.checkpointHash, lastRecordHash: second[1].recordHash,
    });

    // A quiet day still gets a root, so the daily chain has no holes.
    const day2 = await sealDailyCheckpoint(dayOf(2));
    expect(day2).toMatchObject({ fromSequence: 6, toSequence: 5, recordCount: 0, lastRecordHash: day1.lastRecordHash, merkleRoot: GENESIS_HASH });

    await expect(sealDailyCheckpoint(dayOf(1).replace(/\d\d$/, '00'))).rejects.toThrow();
    await expect(sealDailyCheckpoint(dayOf(-5))).rejects.toThrow('already sealed');
    await expect(AuditCheckpoint.updateOne({ _id: day0._id }, { $set: { toSequence: 99 } })).rejects.toThrow('append-only');
    expect(await AuditCheckpoint.countDocuments()).toBe(3);
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: true, checked: 5, checkpointsChecked: 2 });
  });

  it('refuses to seal a range that does not verify', async () => {
    await appendMany(4);
    await raw().updateOne({ sequenceNumber: 2 }, { $set: { suspicionScoreAfter: 0 } });
    const error = await sealDailyCheckpoint(dayOf(0)).catch(e => e);
    expect(error).toBeInstanceOf(AuditChainBrokenError);
    expect(error.report).toMatchObject({ brokenAt: 2, reason: 'hash_mismatch' });
    expect(await AuditCheckpoint.countDocuments()).toBe(0);
  });

  it('flags a checkpoint that was edited or signed with another key', async () => {
    await appendMany(3);
    const sealed = await sealDailyCheckpoint(dayOf(0));
    await AuditCheckpoint.collection.updateOne({ _id: sealed._id }, { $set: { toSequence: 2 } });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, reason: 'checkpoint_tampered', checkpointDay: sealed.day });
    await expect(sealDailyCheckpoint(dayOf(1))).rejects.toThrow('does not match');

    await AuditCheckpoint.collection.updateOne({ _id: sealed._id }, { $set: { toSequence: 3 } });
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: true });
    vi.stubEnv('AUDIT_CHECKPOINT_SECRET', 'some-other-secret');
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: false, reason: 'checkpoint_tampered' });
  });

  it('keeps verifying after the TTL removed the start of the chain', async () => {
    await appendMany(3);
    await sealDailyCheckpoint(dayOf(0));
    await appendMany(2);
    await sealDailyCheckpoint(dayOf(1));
    await appendMany(2);
    await sealDailyCheckpoint(dayOf(2));
    await appendMany(1);

    // 90 days later the first two sealed days are outside the TTL window. The TTL monitor
    // deletes by createdAt; drop those rows by sequence to get the same result now.
    const later = new Date(Date.now() + 90 * DAY);
    await raw().deleteMany({ sequenceNumber: { $lte: 5 } });
    expect(await verifyAuditIntegrity(undefined, undefined, later)).toMatchObject({
      ok: true, anchoredBy: 'checkpoint', fromSequence: 6, toSequence: 8, checked: 3, checkpointsChecked: 1,
    });

    // Losing a record that is still inside the window is not explained by the TTL.
    await raw().deleteOne({ sequenceNumber: 6 });
    expect(await verifyAuditIntegrity(undefined, undefined, later)).toMatchObject({ ok: false, brokenAt: 7, reason: 'sequence_gap' });
  });

  it('continues the chain from the last checkpoint when every record expired', async () => {
    await appendMany(3);
    const sealed = await sealDailyCheckpoint(dayOf(0));
    await raw().deleteMany({});
    const next = await appendChainedAuditEvent({ userId: owner, eventType: 'visibility_changed', triggeredBy: 'user', details: {} });
    expect(next).toMatchObject({ sequenceNumber: 4, previousHash: sealed.lastRecordHash });
    expect(await verifyAuditIntegrity(undefined, undefined, new Date(Date.now() + 100 * DAY))).toMatchObject({
      ok: true, anchoredBy: 'checkpoint', fromSequence: 4, checked: 1,
    });
  });

  it('runs as a daily job that seals yesterday and fails on a broken chain', async () => {
    await appendMany(3);
    const tomorrow = new Date(`${dayOf(1)}T00:30:00.000Z`);
    const { checkpoint, report } = await runDailyAuditCheckpoint(tomorrow);
    expect(checkpoint).toMatchObject({ day: dayOf(0), toSequence: 3 });
    expect(report).toMatchObject({ ok: true, checked: 3 });

    await raw().updateOne({ sequenceNumber: 1 }, { $set: { userId: new Types.ObjectId() } });
    await expect(runDailyAuditCheckpoint(new Date(tomorrow.getTime() + DAY))).rejects.toBeInstanceOf(AuditChainBrokenError);
  });

  it('requires the signing secret in production', async () => {
    vi.stubEnv('AUDIT_CHECKPOINT_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(sealDailyCheckpoint(dayOf(0))).rejects.toThrow('AUDIT_CHECKPOINT_SECRET');
  });

  it('recovers from E11000 upsert race in getOrCreateAuditKey and handles concurrent non-session appends', async () => {
    const { getOrCreateAuditKey } = await import('../../../modules/audit/auditLedger.service.js');
    const { AuditEncryptionKey } = await import('../../../db/models/profileAuditLog.model.js');
    const newUser = new Types.ObjectId();
    const seeded = await getOrCreateAuditKey(newUser);

    // Simulate MongoDB E11000 upsert race on findOneAndUpdate
    const findSpy = vi.spyOn(AuditEncryptionKey, 'findOneAndUpdate').mockReturnValueOnce({
      lean: vi.fn().mockRejectedValueOnce(
        Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
      ),
    } as any);
    const recovered = await getOrCreateAuditKey(newUser);
    expect(recovered.keyHex).toBe(seeded.keyHex);
    expect(recovered.saltHex).toBe(seeded.saltHex);
    findSpy.mockRestore();

    // 6 concurrent non-session appends must all succeed with contiguous sequence numbers
    const appended = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        appendChainedAuditEvent({
          userId: newUser,
          eventType: 'visibility_changed',
          triggeredBy: 'user',
          details: { idx: i },
        })
      )
    );
    expect(appended.map(a => a.sequenceNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await verifyAuditIntegrity()).toMatchObject({ ok: true, checked: 6 });
  });

  it('does not retry E11000 inside an active ClientSession in appendChainedAuditEvent', async () => {
    await appendMany(1);
    const session = await ProfileAuditLog.startSession();
    session.startTransaction();
    const createSpy = vi.spyOn(ProfileAuditLog, 'create').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key error collection: sequenceNumber'), {
        code: 11000,
        keyPattern: { sequenceNumber: 1 },
      })
    );
    try {
      await expect(
        appendChainedAuditEvent(
          { userId: owner, eventType: 'visibility_changed', triggeredBy: 'user', details: {} },
          session
        )
      ).rejects.toThrow('E11000');
      expect(createSpy).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
      await session.abortTransaction();
      await session.endSession();
    }
  });
});
