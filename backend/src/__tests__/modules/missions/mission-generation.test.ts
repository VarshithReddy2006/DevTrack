import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mission, User, UserXp } from '../../../db/models/index.js';
import * as generator from '../../../modules/missions/missionGenerator.service.js';
import { getMissionPeriod } from '../../../modules/missions/missionPeriod.js';
import { eventBus } from '../../../shared/sse/index.js';
import { runScheduledMissionSweep } from '../../../shared/scheduler/missionScheduler.js';

const redis = vi.hoisted(() => ({ status: 'ready', set: vi.fn(), eval: vi.fn() }));
vi.mock('../../../shared/redis/client.js', () => ({ getRedisClient: () => redis }));
vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: { invalidateDashboard: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitNotificationCreated: vi.fn() } }));

const DAY_MS = 24 * 60 * 60 * 1000;

async function createUser() {
  return User.create({
    clerkId: 'mission_generation', username: 'missiongeneration',
    displayName: 'Mission Generation', email: 'mission-generation@example.test',
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('period mission generation', () => {
  it('creates one daily set under concurrent sweeps and preserves progress on rerun', async () => {
    const user = await createUser();
    const now = new Date();
    const period = getMissionPeriod('daily', now);
    await Promise.all(Array.from({ length: 4 }, () => generator.generateDailyMissions(now)));
    const missions = await Mission.find({ userId: user._id, type: 'daily' }).lean();
    expect(missions).toHaveLength(3);
    expect(new Set(missions.map(mission => mission.templateKey)).size).toBe(3);
    expect(missions.every(mission => mission.periodKey === period.key && +mission.expiresAt === +period.end)).toBe(true);
    expect(eventBus.emitNotificationCreated).toHaveBeenCalledTimes(3);

    await Mission.updateMany({ userId: user._id }, { status: 'completed', currentCount: 1 });
    await UserXp.create({ userId: user._id, currentLevel: 8, lifetimeStats: { totalProblemsSolved: 100 } });
    await generator.generateDailyMissions(now);
    expect(await Mission.countDocuments({ userId: user._id, status: 'completed', currentCount: 1 })).toBe(3);
    expect(await Mission.countDocuments({ userId: user._id })).toBe(3);
    expect(eventBus.emitNotificationCreated).toHaveBeenCalledTimes(3);
  });

  it('resumes a partial weekly batch using its original calibration after XP changes', async () => {
    const user = await createUser();
    const now = new Date();
    await UserXp.create({ userId: user._id, currentLevel: 6 });
    vi.mocked(eventBus.emitNotificationCreated).mockImplementationOnce(() => { throw new Error('Interrupted'); });
    await expect(generator.generateWeeklyMissions(now)).rejects.toThrow('Interrupted');
    expect(await Mission.countDocuments({ userId: user._id })).toBe(1);

    await UserXp.updateOne({ userId: user._id }, { currentLevel: 1, 'lifetimeStats.totalProblemsSolved': 100 });
    await Promise.all([generator.generateWeeklyMissions(now), generator.generateWeeklyMissions(now)]);
    const titles = (await Mission.find({ userId: user._id }).lean()).map(mission => mission.title);
    expect(titles.sort()).toEqual(['Complete 2 hard problems', 'Participate in a contest', 'Solve 10 problems this week']);
    expect(eventBus.emitNotificationCreated).toHaveBeenCalledTimes(3);
  });

  it('keeps a completed legacy batch this period and creates a fresh batch at the next UTC boundary', async () => {
    const user = await createUser();
    const now = new Date();
    const period = getMissionPeriod('daily', now);
    await Mission.create({
      userId: user._id, title: 'Legacy', description: 'Existing daily mission', type: 'daily', category: 'dsa',
      targetCount: 1, xpReward: 10, status: 'completed', expiresAt: period.end,
    });
    await generator.generateDailyMissions(now);
    expect(await Mission.countDocuments({ userId: user._id })).toBe(1);
    await generator.generateDailyMissions(period.end);
    expect(await Mission.countDocuments({ userId: user._id })).toBe(4);
  });

  it('uses UTC day and Monday boundaries across a year change', () => {
    const sunday = new Date('2027-01-03T23:59:59.999Z');
    const monday = new Date(+sunday + 1);
    expect(getMissionPeriod('weekly', sunday)).toMatchObject({
      key: 'weekly:2026-12-28', end: monday,
    });
    expect(getMissionPeriod('weekly', monday).key).toBe('weekly:2027-01-04');
    expect(getMissionPeriod('daily', sunday).key).toBe('daily:2027-01-03');
    expect(getMissionPeriod('daily', new Date(+sunday - DAY_MS)).key).toBe('daily:2027-01-02');
  });

  it('batches user mission generation across active users', async () => {
    const users = await Promise.all(Array.from({ length: 5 }, (_, i) => User.create({
      clerkId: `mission_batch_${i}`, username: `batchuser_${i}`,
      displayName: `Batch User ${i}`, email: `batch_${i}@example.test`,
      lastActiveAt: new Date(),
    })));
    const now = new Date();
    await generator.generateDailyMissions(now);
    for (const u of users) {
      expect(await Mission.countDocuments({ userId: u._id, type: 'daily' })).toBe(3);
    }
  });
});

describe('scheduled mission sweep', () => {
  it('skips a competing replica and preserves the period lock on successful completion', async () => {
    const now = new Date('2026-11-12T00:05:00Z');
    let owner: string | undefined;
    redis.set.mockImplementation(async (_key, token: string) => {
      if (owner) return null;
      owner = token;
      return 'OK';
    });
    redis.eval.mockImplementation(async (_script, _count, _key, token: string) => {
      if (owner !== token) return 0;
      owner = undefined;
      return 1;
    });
    let finish!: () => void;
    const daily = vi.spyOn(generator, 'generateDailyMissions').mockImplementation(
      () => new Promise<void>(resolve => { finish = resolve; }),
    );

    const first = runScheduledMissionSweep('daily', now);
    await runScheduledMissionSweep('daily', now);
    expect(daily).toHaveBeenCalledExactlyOnceWith(now);
    expect(redis.set).toHaveBeenCalledWith('missions:scheduler:daily:2026-11-12', owner, 'PX', 900_000, 'NX');
    finish();
    await first;
    // On success, the lock is preserved across workers throughout its TTL and NOT deleted.
    expect(redis.eval).not.toHaveBeenCalled();
    expect(owner).toBeDefined();

    // A competing replica triggering after completion is still blocked by the period lock
    await runScheduledMissionSweep('daily', now);
    expect(daily).toHaveBeenCalledTimes(1);
  });

  it('releases the weekly lease when generation fails', async () => {
    redis.set.mockResolvedValueOnce('OK');
    redis.eval.mockResolvedValueOnce(1);
    const now = new Date('2026-11-12T00:05:00Z');
    vi.spyOn(generator, 'generateWeeklyMissions').mockRejectedValueOnce(new Error('Failed sweep'));
    await expect(runScheduledMissionSweep('weekly', now)).rejects.toThrow('Failed sweep');
    const [key, token] = redis.set.mock.calls[0];
    expect(key).toBe('missions:scheduler:weekly:2026-11-09');
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, key, token);
  });

  it('isolates per-user failures in generateDailyMissions so healthy users still receive missions', async () => {
    const now = new Date();
    const [u1, u2, u3] = await User.create([
      { clerkId: 'm_iso_1', username: 'miso1', displayName: 'M1', email: 'miso1@example.test', lastActiveAt: now },
      { clerkId: 'm_iso_2', username: 'miso2', displayName: 'M2', email: 'miso2@example.test', lastActiveAt: now },
      { clerkId: 'm_iso_3', username: 'miso3', displayName: 'M3', email: 'miso3@example.test', lastActiveAt: now },
    ]);

    const origFindOne = UserXp.findOne.bind(UserXp);
    const spy = vi.spyOn(UserXp, 'findOne').mockImplementation(((filter: any) => {
      if (filter?.userId?.toString() === u2._id.toString()) {
        return { lean: async () => { throw new Error('Transient UserXp read failure'); } } as any;
      }
      return origFindOne(filter);
    }) as any);

    try {
      await expect(generator.generateDailyMissions(now)).rejects.toThrow('Transient UserXp read failure');
      expect(await Mission.countDocuments({ userId: u1._id })).toBe(3);
      expect(await Mission.countDocuments({ userId: u2._id })).toBe(0);
      expect(await Mission.countDocuments({ userId: u3._id })).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });
});
