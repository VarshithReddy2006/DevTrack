// src/__tests__/modules/xp/xp-processor.test.ts
// Integration-style unit tests for the XP processor with in-memory MongoDB.

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { processXpEvent, processMilestoneXp, getUserXp } from '../../../modules/xp/processor.js';
import { UserXp, XpTransaction, UserAnalytics, DailyActivity } from '../../../db/models/index.js';
import { getDashboardStats } from '../../../modules/dashboard/dashboard.service.js';

// Mock non-DB dependencies that the processor calls
vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: {
    emitXpUpdated: vi.fn(),
    emitLevelUp: vi.fn(),
  },
}));

vi.mock('../../../modules/missions/missionProgress.service.js', () => ({
  updateMissionProgress: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    invalidateDashboard: vi.fn().mockResolvedValue(undefined), invalidateAllUserCache: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: {
    updateFromEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('XP Processor — processXpEvent', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('should award XP for a dsa_accepted event (easy)', async () => {
    const result = await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'problem-1',
      difficulty: 'easy',
    });

    expect(result.awarded).toBe(true);
    expect(result.xpAwarded).toBe(10); // easy = 10 XP
    expect(result.duplicate).toBe(false);
    expect(result.levelBefore).toBe(1);
    expect(result.levelAfter).toBe(1);
    expect(result.newTotalXp).toBe(10);
  });

  it('should award correct XP for medium difficulty', async () => {
    const result = await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'problem-2',
      difficulty: 'medium',
    });

    expect(result.awarded).toBe(true);
    expect(result.xpAwarded).toBe(25); // medium = 25 XP
  });

  it('should award correct XP for hard difficulty', async () => {
    const result = await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'problem-3',
      difficulty: 'hard',
    });

    expect(result.awarded).toBe(true);
    expect(result.xpAwarded).toBe(50); // hard = 50 XP
  });

  it('should reject duplicate XP events (idempotency)', async () => {
    // Award once
    await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'dup-problem',
      difficulty: 'easy',
    });

    // Try to award again
    const result = await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'dup-problem',
      difficulty: 'easy',
    });

    expect(result.awarded).toBe(false);
    expect(result.duplicate).toBe(true);
    expect(result.xpAwarded).toBe(0);
  });

  it('should accumulate XP across multiple events', async () => {
    await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'acc-1',
      difficulty: 'hard',
    });

    const result = await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'acc-2',
      difficulty: 'hard',
    });

    expect(result.newTotalXp).toBe(100); // 50 + 50
    expect(result.levelAfter).toBe(2); // 100 XP reaches level 2
    expect(result.leveledUp).toBe(true);
  });

  it('should award contest XP', async () => {
    const result = await processXpEvent({
      userId,
      sourceType: 'dsa_contest',
      sourceId: 'contest-1',
    });

    expect(result.awarded).toBe(true);
    expect(result.xpAwarded).toBe(40); // contestParticipated = 40
  });

  it('should award daily streak XP', async () => {
    const result = await processXpEvent({
      userId,
      sourceType: 'daily_streak',
      sourceId: 'streak-day-5',
    });

    expect(result.awarded).toBe(true);
    expect(result.xpAwarded).toBe(15); // dailyStreak = 15
  });

  it('should award sync XP', async () => {
    const result = await processXpEvent({
      userId,
      sourceType: 'sync_completed',
      sourceId: 'sync-1',
    });

    expect(result.awarded).toBe(true);
    expect(result.xpAwarded).toBe(5); // syncCompleted = 5
  });

  it('should award challenge XP from metadata', async () => {
    const result = await processXpEvent({
      userId,
      sourceType: 'challenge_completed',
      sourceId: 'challenge-1',
      metadata: { xpReward: 100 },
    });

    expect(result.awarded).toBe(true);
    expect(result.xpAwarded).toBe(100);
  });

  it('should use default challenge XP when metadata has no xpReward', async () => {
    const result = await processXpEvent({
      userId,
      sourceType: 'challenge_completed',
      sourceId: 'challenge-2',
    });

    expect(result.awarded).toBe(true);
    expect(result.xpAwarded).toBe(35); // default challenge reward
  });

  it('should create UserXp record if it does not exist', async () => {
    const newUserId = new Types.ObjectId().toHexString();
    const before = await UserXp.findOne({ userId: new Types.ObjectId(newUserId) });
    expect(before).toBeNull();

    await processXpEvent({
      userId: newUserId,
      sourceType: 'dsa_accepted',
      sourceId: 'first-solve',
      difficulty: 'easy',
    });

    const after = await UserXp.findOne({ userId: new Types.ObjectId(newUserId) });
    expect(after).not.toBeNull();
    expect(after!.totalXp).toBe(10);
  });

  it('should detect level-up correctly', async () => {
    // Get user to 90 XP first (need 100 for level 2)
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'p1', difficulty: 'hard' }); // 50
    await processXpEvent({ userId, sourceType: 'dsa_contest', sourceId: 'c1' }); // 40 => total 90

    // This should level up
    const result = await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'p2', difficulty: 'easy' }); // 10 => total 100

    expect(result.leveledUp).toBe(true);
    expect(result.levelBefore).toBe(1);
    expect(result.levelAfter).toBe(2);
    expect(result.newTotalXp).toBe(100);
  });

  it('should update lifetime stats for dsa_accepted', async () => {
    await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'stats-problem',
      difficulty: 'medium',
    });

    const userXp = await UserXp.findOne({ userId: new Types.ObjectId(userId) });
    expect(userXp!.lifetimeStats.totalProblemsSolved).toBe(1);
    expect(userXp!.lifetimeStats.mediumSolved).toBe(1);
  });

  it('should emit XP updated event', async () => {
    const { eventBus } = await import('../../../shared/sse/index.js');

    await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'emit-test',
      difficulty: 'easy',
    });

    expect(eventBus.emitXpUpdated).toHaveBeenCalledWith(
      userId,
      10, // newTotalXp
      10, // xpAwarded
      1,  // levelAfter
      expect.any(Number) // xpToNextLevel
    );
  });
});

describe('XP Processor — processMilestoneXp', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('should not award milestone XP for less than 10 problems', async () => {
    await processMilestoneXp(userId, 5);
    const userXp = await UserXp.findOne({ userId: new Types.ObjectId(userId) });
    expect(userXp).toBeNull();
  });

  it('should award 25 XP milestone for 10 problems solved', async () => {
    // Seed a UserXp record
    await UserXp.create({ userId: new Types.ObjectId(userId) });
    await processMilestoneXp(userId, 10);

    const userXp = await UserXp.findOne({ userId: new Types.ObjectId(userId) });
    expect(userXp!.totalXp).toBe(25);
  });

  it('should be idempotent — no double milestone awards', async () => {
    await UserXp.create({ userId: new Types.ObjectId(userId) });
    await processMilestoneXp(userId, 10);
    await processMilestoneXp(userId, 10);

    const userXp = await UserXp.findOne({ userId: new Types.ObjectId(userId) });
    expect(userXp!.totalXp).toBe(25); // Only one award
  });
});

describe('XP Processor — getUserXp', () => {
  const userId = new Types.ObjectId().toHexString();

  it('should return null for nonexistent user', async () => {
    const result = await getUserXp(new Types.ObjectId().toHexString());
    expect(result).toBeNull();
  });

  it('should return XP summary after processing events', async () => {
    await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'fetch-test-1',
      difficulty: 'medium',
    });

    const result = await getUserXp(userId);
    expect(result).not.toBeNull();
    expect(result!.totalXp).toBe(25);
    expect(result!.currentLevel).toBe(1);
    expect(result!.progressPercent).toBeGreaterThan(0);
  });
});

describe('XP Processor — persisted weekly analytics', () => {
  const monday = new Date(2026, 9, 19);
  let userId: string;

  beforeAll(async () => {
    await Promise.all([UserXp.init(), XpTransaction.init(), UserAnalytics.init()]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Freeze Date only: MongoDB sockets and test cleanup keep real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 21, 12));
    userId = new Types.ObjectId().toHexString();
  });

  afterEach(() => { vi.useRealTimers(); });

  async function expectTotals(id: string, awards: number[], previousXp = 0) {
    const [xp, analytics, transactions] = await Promise.all([
      UserXp.findOne({ userId: id }).lean(),
      UserAnalytics.findOne({ userId: id }).lean(),
      XpTransaction.find({ userId: id }).lean(),
    ]);
    const awarded = awards.reduce((sum, amount) => sum + amount, 0);
    expect(transactions).toHaveLength(awards.length);
    expect(transactions.map(tx => tx.xpAwarded).sort((a, b) => a - b)).toEqual([...awards].sort((a, b) => a - b));
    expect(transactions.reduce((sum, tx) => sum + tx.xpAwarded, 0)).toBe(awarded);
    expect(xp!.totalXp).toBe(previousXp + awarded);
    expect(xp!.lifetimeStats.totalXpEarned).toBe(previousXp + awarded);
    expect(analytics!.totalXp).toBe(previousXp + awarded);
    expect(analytics!.currentLevel).toBe(xp!.currentLevel);
    return analytics!;
  }

  it.each([
    { difficulties: ['easy'], awards: [10] },
    { difficulties: ['easy', 'easy'], awards: [10, 10] },
    { difficulties: ['easy', 'easy', 'easy'], awards: [10, 10, 10] },
    { difficulties: ['easy', 'medium', 'hard'], awards: [10, 25, 50] },
  ] as const)('records only event awards for $difficulties in the same week', async ({ difficulties, awards }) => {
    for (const [index, difficulty] of difficulties.entries()) {
      const result = await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: `weekly-${index}`, difficulty });
      expect(result.xpAwarded).toBe(awards[index]);
    }
    const analytics = await expectTotals(userId, [...awards]);
    expect(analytics.dsaSolveCount).toBe(awards.length);
    expect(analytics.weeklyConsistencyScore).toBe(8);
    expect(analytics.weeklyXPHistory.map(({ weekStart, xp }) => ({ weekStart, xp }))).toEqual([
      { weekStart: monday, xp: awards.reduce((sum, award) => sum + award, 0) },
    ]);
  });

  it('starts Monday with only the new award after Sunday earnings', async () => {
    vi.setSystemTime(new Date(2026, 9, 25, 23, 59, 59, 999));
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'sunday', difficulty: 'hard' });
    vi.setSystemTime(new Date(2026, 9, 26));
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'monday', difficulty: 'easy' });
    const analytics = await expectTotals(userId, [50, 10]);
    expect(analytics.weeklyConsistencyScore).toBe(17);
    expect(analytics.weeklyXPHistory.map(({ weekStart, xp }) => ({ weekStart, xp }))).toEqual([
      { weekStart: monday, xp: 50 }, { weekStart: new Date(2026, 9, 26), xp: 10 },
    ]);
  });

  it('adds only new XP to an existing bucket without repairing historical values', async () => {
    const oldMonday = new Date(2026, 9, 12);
    await UserXp.create({ userId, totalXp: 1000, currentLevel: 5, lifetimeStats: { totalXpEarned: 1000 } });
    await UserAnalytics.create({ userId, totalXp: 1000, currentLevel: 5, currentStreak: 7, bestStreak: 9,
      weeklyXPHistory: [{ weekStart: oldMonday, xp: 999 }, { weekStart: monday, xp: 200 }] });
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'existing-user', difficulty: 'easy' });
    const analytics = await expectTotals(userId, [10], 1000);
    expect(analytics.currentStreak).toBe(7);
    expect(analytics.bestStreak).toBe(9);
    expect(analytics.weeklyXPHistory.map(({ weekStart, xp }) => ({ weekStart, xp }))).toEqual([
      { weekStart: oldMonday, xp: 999 }, { weekStart: monday, xp: 210 },
    ]);
  });

  it('does not count a replayed source twice in either lifetime or weekly totals', async () => {
    const event = { userId, sourceType: 'dsa_accepted' as const, sourceId: 'weekly-replay', difficulty: 'easy' as const };
    await processXpEvent(event);
    const before = await UserAnalytics.findOne({ userId }).lean();
    const replay = await processXpEvent(event);
    expect(replay).toMatchObject({ awarded: false, duplicate: true, xpAwarded: 0, newTotalXp: 10 });
    const analytics = await expectTotals(userId, [10]);
    expect(analytics.weeklyXPHistory[0].xp).toBe(10);
    expect(analytics).toEqual(before);
    const { eventBus } = await import('../../../shared/sse/index.js');
    expect(eventBus.emitXpUpdated).toHaveBeenCalledTimes(1);
  });

  it('keeps users isolated even when they share source IDs', async () => {
    const otherUserId = new Types.ObjectId().toHexString();
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'shared-source', difficulty: 'easy' });
    await processXpEvent({ userId: otherUserId, sourceType: 'dsa_accepted', sourceId: 'shared-source', difficulty: 'hard' });
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'second-source', difficulty: 'easy' });
    const first = await expectTotals(userId, [10, 10]);
    const second = await expectTotals(otherUserId, [50]);
    expect(first.weeklyXPHistory[0].xp).toBe(20);
    expect(second.weeklyXPHistory[0].xp).toBe(50);
  });

  it('retains the latest 12 weeks in descending order when adding a thirteenth', async () => {
    const weeks = Array.from({ length: 13 }, (_, index) => new Date(2026, 9, 19 - index * 7));
    await UserXp.create({ userId, totalXp: 120, currentLevel: 2, lifetimeStats: { totalXpEarned: 120 } });
    await UserAnalytics.create({ userId, totalXp: 120, currentLevel: 2,
      weeklyXPHistory: weeks.slice(1).reverse().map(weekStart => ({ weekStart, xp: 10 })) });
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'thirteenth-week', difficulty: 'easy' });
    const analytics = await expectTotals(userId, [10], 120);
    expect(analytics.weeklyXPHistory.map(({ weekStart }) => weekStart)).toEqual(weeks.slice(0, 12));
    expect(analytics.weeklyXPHistory.map(({ xp }) => xp)).toEqual(Array(12).fill(10));
    expect(analytics.weeklyConsistencyScore).toBe(100);
  });

  it('uses award deltas for supported non-DSA sources including a zero-XP event', async () => {
    const sources = [
      ['focus_session', 50], ['sync_completed', 5], ['daily_streak', 15],
      ['dsa_contest', 40], ['challenge_completed', 35], ['manual', 0],
    ] as const;
    for (const [sourceType, award] of sources) {
      const result = await processXpEvent({ userId, sourceType, sourceId: sourceType });
      expect(result.xpAwarded).toBe(award);
    }
    const analytics = await expectTotals(userId, sources.map(([, award]) => award));
    expect(analytics.weeklyXPHistory[0].xp).toBe(145);
    expect(analytics.dsaSolveCount).toBe(0);
  });

  it('keeps level-up responses and side effects based on cumulative XP', async () => {
    await UserXp.create({ userId, totalXp: 90, lifetimeStats: { totalXpEarned: 90 } });
    await UserAnalytics.create({ userId, totalXp: 90, weeklyXPHistory: [{ weekStart: monday, xp: 90 }] });
    const result = await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'weekly-level-up', difficulty: 'easy' });
    expect(result).toEqual({ awarded: true, duplicate: false, xpAwarded: 10, levelBefore: 1,
      levelAfter: 2, leveledUp: true, newTotalXp: 100 });
    const analytics = await expectTotals(userId, [10], 90);
    const { eventBus } = await import('../../../shared/sse/index.js');
    const { updateMissionProgress } = await import('../../../modules/missions/missionProgress.service.js');
    expect(eventBus.emitXpUpdated).toHaveBeenCalledWith(userId, 100, 10, 2, 150);
    expect(eventBus.emitLevelUp).toHaveBeenCalledWith(userId, 2, 100);
    expect(updateMissionProgress).toHaveBeenCalledWith(userId, 'dsa_solve', { difficulty: 'easy' });
    expect(analytics.weeklyXPHistory[0].xp).toBe(100);
  });

  it('exposes the corrected persisted weekly total through dashboard stats', async () => {
    await DailyActivity.create({ userId, date: new Date(2026, 9, 21), count: 2 });
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'dashboard-1', difficulty: 'easy' });
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'dashboard-2', difficulty: 'easy' });
    const stats = await getDashboardStats(userId, []);
    expect(stats.weeklyXPHistory).toHaveLength(7);
    expect(stats.weeklyXPHistory.filter(day => day.xp > 0).map(day => day.xp)).toEqual([20]);
    expect(stats.weeklyConsistencyScore).toBe(8);
  });
});
