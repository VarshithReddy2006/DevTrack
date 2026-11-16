import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { updateMissionProgress } from '../../../modules/missions/missionProgress.service.js';
import { Mission } from '../../../db/models/index.js';
import { processMissionReward } from '../../../modules/xp/processor.js';
import { eventBus } from '../../../shared/sse/index.js';
import { cacheManager } from '../../../shared/cache/cacheManager.js';

vi.mock('../../../modules/xp/processor.js', () => ({
  processMissionReward: vi.fn().mockResolvedValue({
    awarded: true,
    xpAwarded: 50,
    duplicate: false,
    levelBefore: 1,
    levelAfter: 1,
    leveledUp: false,
    newTotalXp: 50,
  }),
}));

vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: {
    emitMissionProgress: vi.fn(),
    emitNotificationCreated: vi.fn(),
    emitXpUpdated: vi.fn(),
    emitLevelUp: vi.fn(),
  },
}));

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    invalidateDashboard: vi.fn().mockResolvedValue(undefined),
    invalidateAllUserCache: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Mission Progress Concurrency — Issue #85', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
  });

  function createMission(overrides: Partial<{
    title: string;
    category: string;
    targetCount: number;
    currentCount: number;
    type: string;
    status: string;
    expiresAt: Date;
  }> = {}) {
    const future = new Date();
    future.setDate(future.getDate() + 7);

    return Mission.create({
      userId: new Types.ObjectId(userId),
      title: overrides.title ?? 'Solve 5 DSA problems',
      description: 'Solve any 5 DSA problems',
      type: overrides.type ?? 'daily',
      category: overrides.category ?? 'dsa',
      targetCount: overrides.targetCount ?? 5,
      currentCount: overrides.currentCount ?? 0,
      xpReward: 50,
      status: overrides.status ?? 'in_progress',
      expiresAt: overrides.expiresAt ?? future,
    });
  }

  it('handles 5 parallel progress increments without losing updates and completes exactly once', async () => {
    const mission = await createMission({ targetCount: 5, currentCount: 0 });

    // Fire 5 concurrent updates in parallel
    await Promise.all(
      Array.from({ length: 5 }, () =>
        updateMissionProgress(userId, 'dsa_solve', { difficulty: 'medium' })
      )
    );

    const finalDoc = await Mission.findById(mission._id);
    expect(finalDoc).not.toBeNull();
    // 1. Zero lost updates
    expect(finalDoc!.currentCount).toBe(5);
    // 2. Status is completed
    expect(finalDoc!.status).toBe('completed');
    expect(finalDoc!.completedAt).toBeInstanceOf(Date);

    // 3. processMissionReward was invoked exactly once
    expect(processMissionReward).toHaveBeenCalledTimes(1);
    expect(processMissionReward).toHaveBeenCalledWith(userId, mission._id.toString());

    // 4. SSE events reflect persisted progress
    expect(eventBus.emitMissionProgress).toHaveBeenCalledTimes(5);
    const progressCalls = vi.mocked(eventBus.emitMissionProgress).mock.calls;
    // Exactly one call should advertise completed: true
    const completedEmits = progressCalls.filter((call) => call[1].completed === true);
    expect(completedEmits.length).toBeGreaterThanOrEqual(1);

    // 5. Dashboard cache was invalidated
    expect(cacheManager.invalidateDashboard).toHaveBeenCalledWith(userId);
  });

  it('does not allow additional progress increments once completed', async () => {
    const mission = await createMission({ targetCount: 3, currentCount: 3, status: 'completed' });

    await updateMissionProgress(userId, 'dsa_solve', { difficulty: 'easy' });

    const doc = await Mission.findById(mission._id);
    expect(doc!.currentCount).toBe(3);
    expect(doc!.status).toBe('completed');
    expect(processMissionReward).not.toHaveBeenCalled();
  });

  it('gates concurrent completion checks when multiple calls cross targetCount simultaneously', async () => {
    const mission = await createMission({ targetCount: 2, currentCount: 1 });

    // 3 concurrent updates when only 1 is needed to complete
    await Promise.all([
      updateMissionProgress(userId, 'dsa_solve'),
      updateMissionProgress(userId, 'dsa_solve'),
      updateMissionProgress(userId, 'dsa_solve'),
    ]);

    const finalDoc = await Mission.findById(mission._id);
    expect(finalDoc!.status).toBe('completed');
    expect(processMissionReward).toHaveBeenCalledTimes(1);
  });
});
