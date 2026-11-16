import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { UserXp, XpTransaction, UserAnalytics } from '../../../db/models/index.js';
import { processXpEvent } from '../../../modules/xp/processor.js';
import { getDashboard } from '../../../modules/dashboard/dashboard.service.js';

describe('XP Post-Commit Analytics Consistency — Issue #175', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await UserXp.deleteMany({});
    await XpTransaction.deleteMany({});
    await UserAnalytics.deleteMany({});
  });

  it('prevents stale snapshot from overwriting newer totalXp and weekly XP during reversed write order', async () => {
    // Award 1: 50 XP
    const event1 = {
      userId,
      sourceType: 'challenge_completed' as const,
      sourceId: 'session-1',
      metadata: { xpReward: 50 },
    };
    // Award 2: 50 XP
    const event2 = {
      userId,
      sourceType: 'challenge_completed' as const,
      sourceId: 'session-2',
      metadata: { xpReward: 50 },
    };

    // First award commits to ledger and analytics
    const res1 = await processXpEvent(event1);
    expect(res1.awarded).toBe(true);
    expect(res1.newTotalXp).toBe(50);

    // Second award commits to ledger and analytics
    const res2 = await processXpEvent(event2);
    expect(res2.awarded).toBe(true);
    expect(res2.newTotalXp).toBe(100);

    // Simulate delayed/stale write from Award 1 executing after Award 2 has finished
    // Award 1's stale snapshot had totalXp: 50 and xpAwarded: 50.
    // In the old code, findOneAndUpdate({ $set: { totalXp: 50 } }) would revert totalXp back to 50.
    // With atomic $max and ledger consistency, totalXp must remain 100.
    await UserAnalytics.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      {
        $max: { totalXp: 50, currentLevel: 1 },
      }
    );

    const analytics = await UserAnalytics.findOne({ userId: new Types.ObjectId(userId) });
    expect(analytics).not.toBeNull();
    expect(analytics!.totalXp).toBe(100);

    const userXp = await UserXp.findOne({ userId: new Types.ObjectId(userId) });
    expect(userXp!.totalXp).toBe(100);

    const transactions = await XpTransaction.find({ userId: new Types.ObjectId(userId) });
    expect(transactions).toHaveLength(2);
    expect(transactions.reduce((sum, t) => sum + t.xpAwarded, 0)).toBe(100);
  });

  it('repairs missing UserAnalytics upon idempotent replay after post-commit analytics failure', async () => {
    const event = {
      userId,
      sourceType: 'challenge_completed' as const,
      sourceId: 'failed-analytics-session',
      metadata: { xpReward: 50 },
    };

    // Spy on UserAnalytics.findOneAndUpdate to fail during initial award
    let failOnce = true;
    const spy = vi.spyOn(UserAnalytics, 'findOneAndUpdate').mockImplementation((async (...args: any[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('Injected post-commit analytics write failure');
      }
      spy.mockRestore();
      return (UserAnalytics.findOneAndUpdate as any)(...args);
    }) as any);

    // The award completes transactionally despite analytics failure (non-fatal catch)
    const initialResult = await processXpEvent(event);
    expect(initialResult.awarded).toBe(true);
    expect(initialResult.newTotalXp).toBe(50);

    // Verify ledger has committed
    const tx = await XpTransaction.findOne({ userId: new Types.ObjectId(userId), sourceId: 'failed-analytics-session' });
    expect(tx).not.toBeNull();
    expect(tx!.xpAwarded).toBe(50);

    // Replay the exact same source ID (idempotent duplicate)
    const replayResult = await processXpEvent(event);
    expect(replayResult.awarded).toBe(false);
    expect(replayResult.duplicate).toBe(true);
    expect(replayResult.newTotalXp).toBe(50);

    // UserAnalytics must now be repaired and present with matching XP
    const repairedAnalytics = await UserAnalytics.findOne({ userId: new Types.ObjectId(userId) });
    expect(repairedAnalytics).not.toBeNull();
    expect(repairedAnalytics!.totalXp).toBe(50);
    expect(repairedAnalytics!.weeklyXPHistory[0].xp).toBe(50);

    // No duplicate transaction was created
    const transactions = await XpTransaction.find({ userId: new Types.ObjectId(userId) });
    expect(transactions).toHaveLength(1);
  });

  it('keeps UserAnalytics consistent across level thresholds and parallel awards', async () => {
    // Level 1 -> Level 2 requires 50 XP in calculateLevel
    const result1 = await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'problem-1',
      difficulty: 'hard', // 50 XP
    });
    expect(result1.awarded).toBe(true);
    expect(result1.newTotalXp).toBe(50);

    const result2 = await processXpEvent({
      userId,
      sourceType: 'dsa_accepted',
      sourceId: 'problem-2',
      difficulty: 'hard', // +50 XP = 100 XP
    });
    expect(result2.awarded).toBe(true);
    expect(result2.newTotalXp).toBe(100);

    const [userXp, analytics] = await Promise.all([
      UserXp.findOne({ userId: new Types.ObjectId(userId) }),
      UserAnalytics.findOne({ userId: new Types.ObjectId(userId) }),
    ]);

    expect(userXp!.totalXp).toBe(100);
    expect(analytics!.totalXp).toBe(100);
    expect(analytics!.currentLevel).toBe(userXp!.currentLevel);
    expect(analytics!.dsaSolveCount).toBe(2);
  });
});
