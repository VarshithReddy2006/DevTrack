import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { processXpEvent, processMilestoneXp } from '../../../modules/xp/processor.js';
import { UserXp, XpTransaction } from '../../../db/models/index.js';
import { calculateLevel, xpToNextLevel } from '../../../modules/xp/rules.js';
import { eventBus } from '../../../shared/sse/index.js';
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitXpUpdated: vi.fn(), emitLevelUp: vi.fn() } }));
vi.mock('../../../modules/missions/missionProgress.service.js', () => ({ updateMissionProgress: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateDashboard: vi.fn().mockResolvedValue(undefined), invalidateAllUserCache: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { updateFromEvent: vi.fn().mockResolvedValue(undefined) } }));

beforeAll(async () => { await UserXp.init(); await XpTransaction.init(); });
beforeEach(() => vi.clearAllMocks());

async function coherentLedger(userId: string, count: number, total: number) {
  const aggregate = await UserXp.findOne({ userId });
  expect(aggregate?.totalXp).toBe(total);
  expect(aggregate?.currentLevel).toBe(calculateLevel(total));
  expect(aggregate?.xpToNextLevel).toBe(xpToNextLevel(total, calculateLevel(total)));
  const rows = await XpTransaction.find({ userId }).sort({ previousTotalXp: 1 });
  expect(rows).toHaveLength(count);
  let balance = 0;
  for (const row of rows) {
    expect(row.previousTotalXp).toBe(balance);
    balance += row.xpAwarded;
    expect(row.newTotalXp).toBe(balance);
    expect(row.levelBefore).toBe(calculateLevel(row.previousTotalXp));
    expect(row.levelAfter).toBe(calculateLevel(balance));
  }
  expect(balance).toBe(total);
}

describe('XP transactional concurrency with real MongoDB replica set', () => {
  it('serializes 20 parallel varying awards for a new user and emits every crossed level exactly once', async () => {
    const userId = new Types.ObjectId().toHexString();
    const amounts = Array.from({ length: 20 }, (_, index) => 20 + index * 5);
    const results = await Promise.all(amounts.map((xpReward, index) => processXpEvent({ userId, sourceType: 'challenge_completed', sourceId: `parallel-${index}`, metadata: { xpReward } })));
    const total = amounts.reduce((sum, amount) => sum + amount, 0);
    expect(results.every(result => result.awarded)).toBe(true);
    await coherentLedger(userId, 20, total);
    const levels = vi.mocked(eventBus.emitLevelUp).mock.calls.map(call => call[1]).sort((a, b) => a - b);
    expect(levels).toEqual(Array.from({ length: calculateLevel(total) - 1 }, (_, index) => index + 2));
    expect(eventBus.emitXpUpdated).toHaveBeenCalledTimes(20);
  });

  it('20 simultaneous deliveries of the same idempotency key award only once', async () => {
    const userId = new Types.ObjectId().toHexString();
    const results = await Promise.all(Array.from({ length: 20 }, () => processXpEvent({ userId, sourceType: 'challenge_completed', sourceId: 'same', metadata: { xpReward: 300 } })));
    expect(results.filter(result => result.awarded)).toHaveLength(1);
    expect(results.filter(result => result.duplicate)).toHaveLength(19);
    await coherentLedger(userId, 1, 300);
    expect(eventBus.emitXpUpdated).toHaveBeenCalledTimes(1);
    expect(vi.mocked(eventBus.emitLevelUp).mock.calls.map(call => call[1])).toEqual([2, 3]);
  });

  it('rolls back aggregate/counters when ledger insertion fails, publishes nothing and permits retry', async () => {
    const userId = new Types.ObjectId().toHexString();
    const insertion = vi.spyOn(XpTransaction, 'create').mockRejectedValueOnce(new Error('injected ledger failure'));
    await expect(processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'retry', difficulty: 'hard' })).rejects.toThrow('injected ledger failure');
    insertion.mockRestore();
    const aggregate = await UserXp.findOne({ userId });
    expect(aggregate?.totalXp).toBe(0); expect(aggregate?.lifetimeStats.totalProblemsSolved).toBe(0);
    expect(await XpTransaction.countDocuments({ userId })).toBe(0);
    expect(eventBus.emitXpUpdated).not.toHaveBeenCalled(); expect(eventBus.emitLevelUp).not.toHaveBeenCalled();
    await processXpEvent({ userId, sourceType: 'dsa_accepted', sourceId: 'retry', difficulty: 'hard' });
    await coherentLedger(userId, 1, 50);
  });

  it('milestone and ordinary awards share one atomic ledger and duplicate guard', async () => {
    const userId = new Types.ObjectId().toHexString();
    await Promise.all([processMilestoneXp(userId, 100), processMilestoneXp(userId, 100),
      processXpEvent({ userId, sourceType: 'challenge_completed', sourceId: 'ordinary', metadata: { xpReward: 100 } })]);
    await coherentLedger(userId, 2, 300);
    expect(eventBus.emitXpUpdated).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe/negative awards before creating a ledger or aggregate', async () => {
    const userId = new Types.ObjectId().toHexString();
    for (const xpReward of [-1, Infinity, 0.5]) await expect(processXpEvent({ userId, sourceType: 'challenge_completed', sourceId: String(xpReward), metadata: { xpReward } })).rejects.toThrow();
    expect(await UserXp.countDocuments({ userId })).toBe(0);
  });
});
