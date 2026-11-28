import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { User } from '../../../db/models/user.model.js';
import { Quest } from '../../../db/models/quest.model.js';
import { UserQuestProgress } from '../../../db/models/userQuestProgress.model.js';
import { expireStaleQuests, generateUserQuests, listUserQuests } from '../../../modules/quests/questEngine.service.js';
import {
  QUEST_EXPIRATION_LOCK_KEY,
  runQuestExpirationWorkerSweep,
  scheduleQuestExpiration,
} from '../../../modules/quests/questExpiration.worker.js';

const mocks = vi.hoisted(() => ({
  invalidateAllUserCache: vi.fn().mockResolvedValue(undefined),
  withDistributedLock: vi.fn(),
}));

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    invalidateAllUserCache: mocks.invalidateAllUserCache,
  },
}));

vi.mock('../../../shared/redis/distributedLock.js', () => ({
  withDistributedLock: mocks.withDistributedLock,
}));

describe('quest expiration and archival worker', () => {
  const userId1 = '111111111111111111111111';
  const userId2 = '222222222222222222222222';
  let questId: Types.ObjectId;

  beforeAll(async () => {
    await Promise.all([User.init(), Quest.init(), UserQuestProgress.init()]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.invalidateAllUserCache.mockResolvedValue(undefined);
    mocks.withDistributedLock.mockImplementation(async (_key, task) => ({
      executed: true,
      result: await task({}),
    }));

    await User.create([
      {
        _id: userId1,
        clerkId: 'expire-test-1',
        email: 'expire1@example.test',
        username: 'expire-tester-1',
        displayName: 'Expire Tester 1',
      },
      {
        _id: userId2,
        clerkId: 'expire-test-2',
        email: 'expire2@example.test',
        username: 'expire-tester-2',
        displayName: 'Expire Tester 2',
      },
    ]);

    const quest = await Quest.create({
      key: 'v1:bronze:weekly:dsa_solve',
      slot: 'weekly:dsa_solve',
      cadence: 'weekly',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 10 distinct problems',
      targetCount: 10,
      xpReward: 100,
      trophyReward: 5,
    });
    questId = quest._id;
  });

  afterEach(async () => {
    await Promise.all([
      UserQuestProgress.deleteMany({}),
      Quest.deleteMany({}),
      User.deleteMany({}),
    ]);
  });

  it('transitions expired in-progress quests in batches, computes finalProgressPct, and invalidates user caches', async () => {
    const now = new Date('2026-11-23T00:05:00.000Z');
    const pastExpiry = new Date('2026-11-23T00:00:00.000Z');
    const futureExpiry = new Date('2026-11-30T00:00:00.000Z');

    const stale1 = await UserQuestProgress.create({
      userId: userId1,
      questId,
      periodKey: 'weekly:2026-11-15',
      slot: 'weekly:dsa_solve',
      cadence: 'weekly',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 10 distinct problems',
      targetCount: 10,
      xpReward: 100,
      trophyReward: 5,
      startsAt: new Date('2026-11-15T00:00:00.000Z'),
      expiresAt: pastExpiry,
      currentCount: 3,
      status: 'in_progress',
      completed: false,
    });

    const stale2 = await UserQuestProgress.create({
      userId: userId1,
      questId,
      periodKey: 'daily:2026-11-22',
      slot: 'daily:dsa_solve',
      cadence: 'daily',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 2 distinct problems',
      targetCount: 2,
      xpReward: 20,
      trophyReward: 1,
      startsAt: new Date('2026-11-22T00:00:00.000Z'),
      expiresAt: pastExpiry,
      currentCount: 1,
      status: 'in_progress',
      completed: false,
    });

    const stale3 = await UserQuestProgress.create({
      userId: userId2,
      questId,
      periodKey: 'weekly:2026-11-15',
      slot: 'weekly:dsa_solve',
      cadence: 'weekly',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 10 distinct problems',
      targetCount: 10,
      xpReward: 100,
      trophyReward: 5,
      startsAt: new Date('2026-11-15T00:00:00.000Z'),
      expiresAt: pastExpiry,
      currentCount: 0,
      status: 'in_progress',
      completed: false,
    });

    const completedPast = await UserQuestProgress.create({
      userId: userId2,
      questId,
      periodKey: 'daily:2026-11-22',
      slot: 'daily:dsa_solve',
      cadence: 'daily',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 2 distinct problems',
      targetCount: 2,
      xpReward: 20,
      trophyReward: 1,
      startsAt: new Date('2026-11-22T00:00:00.000Z'),
      expiresAt: pastExpiry,
      currentCount: 2,
      status: 'completed',
      completed: true,
      completedAt: new Date('2026-11-22T12:00:00.000Z'),
    });

    const activeFuture = await UserQuestProgress.create({
      userId: userId1,
      questId,
      periodKey: 'weekly:2026-11-22',
      slot: 'weekly:dsa_solve',
      cadence: 'weekly',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 10 distinct problems',
      targetCount: 10,
      xpReward: 100,
      trophyReward: 5,
      startsAt: new Date('2026-11-22T00:00:00.000Z'),
      expiresAt: futureExpiry,
      currentCount: 2,
      status: 'in_progress',
      completed: false,
    });

    const result = await expireStaleQuests(2, now, 90);
    expect(result).toEqual({
      expiredCount: 3,
      archivedCount: 0,
      invalidatedUsers: 2,
    });

    const updated1 = await UserQuestProgress.findById(stale1._id).lean();
    const updated2 = await UserQuestProgress.findById(stale2._id).lean();
    const updated3 = await UserQuestProgress.findById(stale3._id).lean();
    const untouchedCompleted = await UserQuestProgress.findById(completedPast._id).lean();
    const untouchedActive = await UserQuestProgress.findById(activeFuture._id).lean();

    expect(updated1).toMatchObject({ status: 'expired', finalProgressPct: 30, expiredAt: now });
    expect(updated2).toMatchObject({ status: 'expired', finalProgressPct: 50, expiredAt: now });
    expect(updated3).toMatchObject({ status: 'expired', finalProgressPct: 0, expiredAt: now });
    expect(untouchedCompleted).toMatchObject({ status: 'completed', expiredAt: null });
    expect(untouchedActive).toMatchObject({ status: 'in_progress', expiredAt: null });

    expect(mocks.invalidateAllUserCache).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateAllUserCache).toHaveBeenCalledWith(userId1);
    expect(mocks.invalidateAllUserCache).toHaveBeenCalledWith(userId2);
  });

  it('stops expiration and archival batches when no records are modified', async () => {
    const now = new Date('2026-11-23T00:05:00.000Z');
    const recentExpiry = new Date(now.getTime() - 86_400_000);
    const oldExpiry = new Date(now.getTime() - 91 * 86_400_000);
    const baseProgress = {
      userId: userId1,
      questId,
      slot: 'daily:dsa_solve',
      cadence: 'daily' as const,
      division: 'bronze' as const,
      kind: 'dsa_solve' as const,
      title: 'Solve 2 distinct problems',
      targetCount: 2,
      xpReward: 20,
      trophyReward: 1,
      startsAt: new Date('2026-11-01T00:00:00.000Z'),
      currentCount: 1,
      completed: false,
    };

    await UserQuestProgress.create([
      { ...baseProgress, periodKey: 'daily:stale-1', expiresAt: recentExpiry, status: 'in_progress' },
      { ...baseProgress, periodKey: 'daily:stale-2', expiresAt: recentExpiry, status: 'in_progress' },
      { ...baseProgress, periodKey: 'daily:old-1', expiresAt: oldExpiry, status: 'expired' },
      { ...baseProgress, periodKey: 'daily:old-2', expiresAt: oldExpiry, status: 'expired' },
    ]);

    const bulkWriteSpy = vi
      .spyOn(UserQuestProgress, 'bulkWrite')
      .mockResolvedValue({ modifiedCount: 0 } as never);
    const updateManySpy = vi
      .spyOn(UserQuestProgress, 'updateMany')
      .mockResolvedValue({ modifiedCount: 0 } as never);

    try {
      const result = await expireStaleQuests(2, now, 90);

      expect(result).toEqual({ expiredCount: 0, archivedCount: 0, invalidatedUsers: 0 });
      expect(bulkWriteSpy).toHaveBeenCalledTimes(1);
      expect(updateManySpy).toHaveBeenCalledTimes(1);
    } finally {
      bulkWriteSpy.mockRestore();
      updateManySpy.mockRestore();
    }
  });

  it('archives records older than 90 days without touching recent expired records', async () => {
    const now = new Date('2026-11-23T00:05:00.000Z');
    const oldExpiry = new Date(now.getTime() - 95 * 86_400_000);
    const recentExpiry = new Date(now.getTime() - 10 * 86_400_000);

    const oldDoc = await UserQuestProgress.create({
      userId: userId1,
      questId,
      periodKey: 'weekly:2026-08-10',
      slot: 'weekly:dsa_solve',
      cadence: 'weekly',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 10 distinct problems',
      targetCount: 10,
      xpReward: 100,
      trophyReward: 5,
      startsAt: new Date(oldExpiry.getTime() - 7 * 86_400_000),
      expiresAt: oldExpiry,
      currentCount: 4,
      status: 'expired',
      expiredAt: oldExpiry,
      completed: false,
    });

    const recentDoc = await UserQuestProgress.create({
      userId: userId1,
      questId,
      periodKey: 'weekly:2026-11-08',
      slot: 'weekly:dsa_solve',
      cadence: 'weekly',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 10 distinct problems',
      targetCount: 10,
      xpReward: 100,
      trophyReward: 5,
      startsAt: new Date(recentExpiry.getTime() - 7 * 86_400_000),
      expiresAt: recentExpiry,
      currentCount: 1,
      status: 'expired',
      expiredAt: recentExpiry,
      completed: false,
    });

    const result = await expireStaleQuests(1, now, 90);
    expect(result).toEqual({
      expiredCount: 0,
      archivedCount: 1,
      invalidatedUsers: 0,
    });

    expect(await UserQuestProgress.findById(oldDoc._id).lean()).toMatchObject({
      status: 'archived',
      archivedAt: now,
    });
    expect(await UserQuestProgress.findById(recentDoc._id).lean()).toMatchObject({
      status: 'expired',
      archivedAt: null,
    });
  });

  it('continues cleanly if cache invalidation rejects for an affected user', async () => {
    const now = new Date('2026-11-23T00:05:00.000Z');
    await UserQuestProgress.create({
      userId: userId1,
      questId,
      periodKey: 'weekly:2026-11-15',
      slot: 'weekly:dsa_solve',
      cadence: 'weekly',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 10 distinct problems',
      targetCount: 10,
      xpReward: 100,
      trophyReward: 5,
      startsAt: new Date('2026-11-15T00:00:00.000Z'),
      expiresAt: new Date('2026-11-23T00:00:00.000Z'),
      currentCount: 2,
      status: 'in_progress',
      completed: false,
    });

    mocks.invalidateAllUserCache.mockRejectedValueOnce(new Error('Redis unavailable'));

    const result = await expireStaleQuests(50, now);
    expect(result.expiredCount).toBe(1);
    expect(result.invalidatedUsers).toBe(1);
  });

  it('excludes expired quests from listUserQuests dashboard queries', async () => {
    const now = new Date('2026-11-23T12:00:00.000Z');
    const rows = await generateUserQuests(userId1, now);
    await UserQuestProgress.updateOne(
      { _id: rows[0]._id },
      { $set: { status: 'expired', expiredAt: now } }
    );

    const view = await listUserQuests(userId1, now);
    expect(view.quests).toHaveLength(rows.length - 1);
    expect(view.quests.every(q => q.status !== 'expired' && q.status !== 'archived')).toBe(true);
  });

  it('runs worker sweep under distributed lock and skips when lock is held', async () => {
    const now = new Date('2026-11-23T00:05:00.000Z');
    await UserQuestProgress.create({
      userId: userId1,
      questId,
      periodKey: 'weekly:2026-11-15',
      slot: 'weekly:dsa_solve',
      cadence: 'weekly',
      division: 'bronze',
      kind: 'dsa_solve',
      title: 'Solve 10 distinct problems',
      targetCount: 10,
      xpReward: 100,
      trophyReward: 5,
      startsAt: new Date('2026-11-15T00:00:00.000Z'),
      expiresAt: new Date('2026-11-23T00:00:00.000Z'),
      currentCount: 5,
      status: 'in_progress',
      completed: false,
    });

    const executed = await runQuestExpirationWorkerSweep({ batchSize: 10, now });
    expect(executed).toEqual({
      executed: true,
      expiredCount: 1,
      archivedCount: 0,
      invalidatedUsers: 1,
    });
    expect(mocks.withDistributedLock).toHaveBeenCalledWith(
      'expire_quests',
      expect.any(Function),
      expect.objectContaining({
        lockKey: QUEST_EXPIRATION_LOCK_KEY,
        autoRenew: true,
      })
    );

    mocks.withDistributedLock.mockResolvedValueOnce({
      executed: false,
      reason: 'lock_held',
    });
    const skipped = await runQuestExpirationWorkerSweep({ batchSize: 10, now });
    expect(skipped).toEqual({
      executed: false,
      reason: 'lock_held',
      expiredCount: 0,
      archivedCount: 0,
      invalidatedUsers: 0,
    });
  });

  it('registers daily 00:00 UTC and weekly Monday 00:05 UTC expiration jobs', async () => {
    const add = vi.fn().mockResolvedValue({});
    const removeRepeatable = vi.fn().mockResolvedValue(true);
    await scheduleQuestExpiration({ add, removeRepeatable } as never);

    expect(removeRepeatable).toHaveBeenCalledWith(
      'expire-quests-weekly',
      { pattern: '59 23 * * 0', tz: 'UTC' },
      'quests-expire-weekly'
    );

    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0][0]).toBe('expire-quests-daily');
    expect(add.mock.calls[0][1]).toEqual({ task: 'expire_quests' });
    expect(add.mock.calls[0][2]).toMatchObject({
      repeat: { pattern: '0 0 * * *', tz: 'UTC' },
      jobId: 'quests-expire-daily',
      attempts: 5,
    });

    expect(add.mock.calls[1][0]).toBe('expire-quests-weekly');
    expect(add.mock.calls[1][1]).toEqual({ task: 'expire_quests' });
    expect(add.mock.calls[1][2]).toMatchObject({
      repeat: { pattern: '5 0 * * 1', tz: 'UTC' },
      jobId: 'quests-expire-weekly',
      attempts: 5,
    });
  });
});
