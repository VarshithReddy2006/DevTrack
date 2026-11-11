import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { User, UserXp, UserAnalytics, Mission, XpTransaction, type XpSourceType } from '../../../db/models/index.js';
import { processXpEvent, processMissionReward, getUserXp } from '../../../modules/xp/processor.js';
import { updateMissionProgress, getUserMissions } from '../../../modules/missions/missionProgress.service.js';
import { generateDailyMissions, generateWeeklyMissions } from '../../../modules/missions/missionGenerator.service.js';
import { eventBus } from '../../../shared/sse/index.js';
import { unifiedRuntimeStateService } from '../../../modules/runtime-state/unifiedRuntimeState.service.js';

// Keep mission generation/progress, XP processing and MongoDB persistence real.
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: {
  emitXpUpdated: vi.fn(), emitLevelUp: vi.fn(), emitMissionProgress: vi.fn(), emitNotificationCreated: vi.fn(),
} }));
vi.mock('../../../shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateDashboard: vi.fn().mockResolvedValue(undefined), invalidateAllUserCache: vi.fn() } }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { updateFromEvent: vi.fn() } }));
vi.mock('../../../shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const userId = '000000000000000000000051';
const otherId = '000000000000000000000052';
const now = new Date(2026, 9, 28, 12);
beforeAll(async () => {
  // The ledger unique index must be ready before any award. Mission's unrelated
  // conflicting expiry indexes are not awaited, matching existing mission tests.
  await Promise.all([User.init(), UserXp.init(), UserAnalytics.init(), XpTransaction.init()]);
  // Keep one calendar clock for the whole suite so MongoDB heartbeats cannot
  // jump between real time and the frozen date during per-test DB cleanup.
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
});
beforeEach(async () => {
  vi.clearAllMocks();
  await User.create({ _id: userId, clerkId: 'reward_owner', username: 'rewardowner', displayName: 'Synthetic Owner', email: 'owner@example.test' });
  await UserXp.create({ userId });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { vi.useRealTimers(); });

async function createMission(overrides: Record<string, unknown> = {}) {
  return Mission.create({ userId, title: 'Solve a easy problem', description: 'Synthetic mission', type: 'daily', category: 'dsa',
    targetCount: 1, currentCount: 0, xpReward: 25, expiresAt: new Date(now.getTime() + 86_400_000), ...overrides });
}
async function solve(sourceId: string, owner = userId) {
  return processXpEvent({ userId: owner, sourceType: 'dsa_accepted', sourceId, difficulty: 'easy' });
}
async function rewardFor(missionId: string) {
  return XpTransaction.findOne({ userId, sourceType: 'manual', sourceId: `mission_${missionId}` }).lean();
}

it('credits the real generated daily bonus alongside the unchanged solve reward', async () => {
  await generateDailyMissions();
  const mission = await Mission.findOne({ userId, title: 'Solve a easy problem' });
  expect(mission).not.toBeNull(); expect(mission!.xpReward).toBe(15);
  expect(await getUserMissions(userId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: mission!.id, xpReward: 15 })]));
  vi.mocked(eventBus.emitNotificationCreated).mockClear();
  await solve('generated-daily');
  expect(await Mission.findById(mission!._id).lean()).toMatchObject({ currentCount: 1, status: 'completed' });
  expect((await XpTransaction.findOne({ userId, sourceType: 'dsa_accepted' }))!.xpAwarded).toBe(10);
  expect.soft((await rewardFor(mission!.id))!.xpAwarded).toBe(15);
  expect.soft((await getUserXp(userId))!.totalXp).toBe(25);
  expect(await XpTransaction.countDocuments({ userId })).toBe(2); // no reward recursion
  expect(await Mission.findOne({ userId, title: 'Solve 2 problems today' }).lean()).toMatchObject({ currentCount: 1, status: 'in_progress' });
  expect(eventBus.emitNotificationCreated).toHaveBeenCalledExactlyOnceWith(userId, `mission_completion_${mission!.id}`,
    'mission_completed', 'Mission Complete! 🎉', 'Solve a easy problem — +15 XP', 'celebration', 'medium');
});

it('credits the real generated weekly contest bonus alongside the unchanged contest reward', async () => {
  await generateWeeklyMissions();
  const mission = await Mission.findOne({ userId, title: 'Participate in a contest' });
  expect(mission).not.toBeNull(); expect(mission!.xpReward).toBe(100);
  vi.mocked(eventBus.emitNotificationCreated).mockClear();
  await processXpEvent({ userId, sourceType: 'dsa_contest', sourceId: 'generated-contest' });
  expect((await Mission.findById(mission!._id))!.status).toBe('completed');
  expect.soft((await rewardFor(mission!.id))!.xpAwarded).toBe(100);
  expect((await getUserXp(userId))!.totalXp).toBe(140);
  expect(eventBus.emitNotificationCreated).toHaveBeenCalledWith(userId, `mission_completion_${mission!.id}`,
    'mission_completed', 'Mission Complete! 🎉', 'Participate in a contest — +100 XP', 'celebration', 'medium');
});

it('awards a multi-step bonus only on the final qualifying activity', async () => {
  const mission = await createMission({ targetCount: 2 });
  await solve('step-one');
  expect((await getUserXp(userId))!.totalXp).toBe(10);
  expect(await rewardFor(mission.id)).toBeNull();
  expect(eventBus.emitNotificationCreated).not.toHaveBeenCalled();
  await solve('step-two');
  expect(await Mission.findById(mission._id).lean()).toMatchObject({ status: 'completed', currentCount: 2 });
  expect.soft((await rewardFor(mission.id))!.xpAwarded).toBe(25);
  expect((await getUserXp(userId))!.totalXp).toBe(45);
});

it('credits direct mission progress without inventing an unrelated base event', async () => {
  const mission = await createMission();
  await updateMissionProgress(userId, 'dsa_solve', { difficulty: 'easy' });
  expect.soft((await getUserXp(userId))!.totalXp).toBe(25);
  expect(await XpTransaction.countDocuments({ userId })).toBe(1);
  expect((await rewardFor(mission.id))!.xpAwarded).toBe(25);
});

it('persists a bonus-driven level crossing and exposes it on later XP reads', async () => {
  await UserXp.updateOne({ userId }, { $set: { totalXp: 90, currentLevel: 1, xpToNextLevel: 10, 'lifetimeStats.totalXpEarned': 90 } });
  await createMission(); await updateMissionProgress(userId, 'dsa_solve', { difficulty: 'easy' });
  expect(await getUserXp(userId)).toMatchObject({ totalXp: 115, currentLevel: 2, xpToNextLevel: 135 });
  expect(eventBus.emitLevelUp).toHaveBeenCalledExactlyOnceWith(userId, 2, 115);
});

it('does not pay twice on a replay or another activity after completion', async () => {
  const mission = await createMission();
  await solve('same-event'); expect((await solve('same-event')).duplicate).toBe(true);
  await solve('later-event');
  expect(await XpTransaction.countDocuments({ userId, sourceId: `mission_${mission.id}` })).toBe(1);
  expect.soft((await getUserXp(userId))!.totalXp).toBe(10 + 10 + 25);
  expect(eventBus.emitNotificationCreated).toHaveBeenCalledTimes(1);
});

it('keeps runtime and analytics state at the awarded bonus total', async () => {
  await createMission(); await solve('runtime-order');
  const totals = vi.mocked(unifiedRuntimeStateService.updateFromEvent).mock.calls.map(([event]) => event.data.newTotalXp);
  expect.soft(totals).toEqual([10, 35]);
  expect((await UserAnalytics.findOne({ userId }))!.totalXp).toBe(35);
});

it('publishes a nested bonus level-up after the triggering base event', async () => {
  await UserXp.updateOne({ userId }, { $set: { totalXp: 80, currentLevel: 1, xpToNextLevel: 20 } });
  await createMission();
  const baseAward = await solve('nested-level');
  // The returned result/ledger remain snapshots of the base award itself.
  expect(baseAward).toMatchObject({ xpAwarded: 10, newTotalXp: 90, levelAfter: 1 });
  expect.soft(await getUserXp(userId)).toMatchObject({ totalXp: 115, currentLevel: 2, xpToNextLevel: 135 });
  const levels = vi.mocked(unifiedRuntimeStateService.updateFromEvent).mock.calls.map(([event]) => event.data.levelAfter);
  expect(levels).toEqual([1, 2]);
});

it.each(['wrong-difficulty', 'expired', 'incomplete', 'other-user'] as const)('does not award a %s mission', async scenario => {
  const mission = await createMission({
    ...(scenario === 'wrong-difficulty' ? { title: 'Solve a hard problem' } : {}),
    ...(scenario === 'expired' ? { expiresAt: new Date(now.getTime() - 1) } : {}),
    ...(scenario === 'incomplete' ? { targetCount: 2 } : {}),
    ...(scenario === 'other-user' ? { userId: otherId } : {}),
  });
  await solve(`control-${scenario}`);
  expect((await getUserXp(userId))!.totalXp).toBe(10);
  expect(await rewardFor(mission.id)).toBeNull();
  expect(await XpTransaction.countDocuments({ userId: otherId })).toBe(0);
  expect(eventBus.emitNotificationCreated).not.toHaveBeenCalled();
});

it('supports an intentional zero bonus without inventing XP', async () => {
  const mission = await createMission({ xpReward: 0 }); await solve('zero-reward');
  expect((await getUserXp(userId))!.totalXp).toBe(10);
  expect((await rewardFor(mission.id))!.xpAwarded).toBe(0);
  expect((await Mission.findById(mission._id))!.status).toBe('completed');
});

it.each([undefined, { xpReward: 50_000, missionId: 'forged', trusted: true }])('keeps manual metadata untrusted (%j)', async metadata => {
  const payload = { userId, sourceType: 'manual' as const, sourceId: 'untrusted-manual', metadata, trustedMissionReward: 50_000 };
  expect(await processXpEvent(payload)).toMatchObject({ xpAwarded: 0, newTotalXp: 0 });
  expect((await getUserXp(userId))!.totalXp).toBe(0);
});

it('leaves historical completed zero-XP mission transactions unchanged', async () => {
  const mission = await createMission({ status: 'completed', currentCount: 1, completedAt: now });
  const history = await XpTransaction.create({ userId, sourceType: 'manual', sourceId: `mission_${mission.id}`,
    xpAwarded: 0, previousTotalXp: 0, newTotalXp: 0, levelBefore: 1, levelAfter: 1 });
  const before = await XpTransaction.findById(history._id).lean();
  await solve('after-historical-completion');
  expect(await XpTransaction.findById(history._id).lean()).toEqual(before);
  expect((await getUserXp(userId))!.totalXp).toBe(10);
  expect(eventBus.emitNotificationCreated).not.toHaveBeenCalled();
});

const sourceAwards: Array<[XpSourceType, number]> = [
  ['dsa_accepted', 10], ['dsa_contest', 40], ['daily_streak', 15], ['sync_completed', 5],
  ['challenge_completed', 35], ['focus_session', 50], ['milestone', 0], ['manual', 0],
];
it.each(sourceAwards)('preserves the existing %s award of %i XP', async (sourceType, amount) => {
  const result = await processXpEvent({ userId, sourceType, sourceId: sourceType, difficulty: 'easy' });
  expect(result.xpAwarded).toBe(amount); expect((await getUserXp(userId))!.totalXp).toBe(amount);
});

async function completedMission(overrides: Record<string, unknown> = {}) {
  return createMission({ status: 'completed', currentCount: 1, completedAt: now, ...overrides });
}

it('loads the owned completed mission amount from MongoDB and deduplicates a direct retry', async () => {
  const mission = await completedMission();
  expect(await processMissionReward(userId, mission.id)).toMatchObject({ awarded: true, xpAwarded: 25, newTotalXp: 25 });
  expect(await processMissionReward(userId, mission.id)).toMatchObject({ awarded: false, duplicate: true, xpAwarded: 0 });
  expect((await rewardFor(mission.id))!.metadata).toMatchObject({ xpReward: 25, missionTitle: mission.title });
  expect((await getUserXp(userId))!.totalXp).toBe(25);
  expect(await XpTransaction.countDocuments({ userId })).toBe(1);
});

it('rejects another user and missing mission without creating an award', async () => {
  const mission = await completedMission();
  await expect(processMissionReward(otherId, mission.id)).rejects.toThrow('not eligible');
  await expect(processMissionReward(userId, '000000000000000000000099')).rejects.toThrow('not eligible');
  expect(await XpTransaction.countDocuments({})).toBe(0);
  expect((await getUserXp(userId))!.totalXp).toBe(0);
});

it.each([
  ['pending', { status: 'pending' }], ['in-progress', { status: 'in_progress' }],
  ['expired-status', { status: 'expired' }], ['expired-time', { expiresAt: new Date(now.getTime() - 1) }],
  ['unfinished-target', { currentCount: 0 }], ['zero-target', { targetCount: 0 }], ['missing-completion-time', { completedAt: null }],
] as const)('rejects an ineligible %s mission in the internal entry point', async (_name, fields) => {
  const mission = await completedMission(fields);
  await expect(processMissionReward(userId, mission.id)).rejects.toThrow('not eligible');
  expect(await XpTransaction.countDocuments({ userId })).toBe(0);
});

it.each([
  ['negative', -1], ['NaN', Number.NaN], ['infinity', Number.POSITIVE_INFINITY], ['negative-infinity', Number.NEGATIVE_INFINITY],
  ['fractional', 0.5], ['unsafe-integer', Number.MAX_SAFE_INTEGER + 1], ['string', '2500'], ['null', null],
] as const)('rejects a %s stored reward before ledger or aggregate writes', async (_name, amount) => {
  const mission = await completedMission();
  // Bypass Mongoose casting deliberately to model invalid persisted configuration.
  await Mission.collection.updateOne({ _id: mission._id }, { $set: { xpReward: amount } });
  await expect(processMissionReward(userId, mission.id)).rejects.toThrow('nonnegative safe integer');
  expect(await rewardFor(mission.id)).toBeNull();
  expect((await getUserXp(userId))!.totalXp).toBe(0);
  expect(eventBus.emitXpUpdated).not.toHaveBeenCalled();
});

it('rejects an overflowing aggregate before writing a mission transaction', async () => {
  const mission = await completedMission();
  await UserXp.updateOne({ userId }, { $set: { totalXp: Number.MAX_SAFE_INTEGER, currentLevel: 15, xpToNextLevel: 0 } });
  await expect(processMissionReward(userId, mission.id)).rejects.toThrow('unsafe XP total');
  expect(await rewardFor(mission.id)).toBeNull();
  expect((await getUserXp(userId))!.totalXp).toBe(Number.MAX_SAFE_INTEGER);
});

it('does not announce a bonus rejected for invalid server configuration', async () => {
  const mission = await createMission({ xpReward: -1 });
  await updateMissionProgress(userId, 'dsa_solve', { difficulty: 'easy' });
  expect(await rewardFor(mission.id)).toBeNull();
  expect((await getUserXp(userId))!.totalXp).toBe(0);
  expect(eventBus.emitNotificationCreated).not.toHaveBeenCalled();
});

it('does not rewrite or announce an existing zero-XP ledger admission', async () => {
  const mission = await createMission();
  const history = await XpTransaction.create({ userId, sourceType: 'manual', sourceId: `mission_${mission.id}`,
    xpAwarded: 0, previousTotalXp: 0, newTotalXp: 0, levelBefore: 1, levelAfter: 1 });
  const before = await XpTransaction.findById(history._id).lean();
  await updateMissionProgress(userId, 'dsa_solve', { difficulty: 'easy' });
  expect(await XpTransaction.findById(history._id).lean()).toEqual(before);
  expect(await processMissionReward(userId, mission.id)).toMatchObject({ awarded: false, duplicate: true });
  expect((await getUserXp(userId))!.totalXp).toBe(0);
  expect(eventBus.emitNotificationCreated).not.toHaveBeenCalled();
});

it('uses the existing unique ledger key when two trusted award calls overlap', async () => {
  const mission = await completedMission();
  const findOne = UserXp.findOne.bind(UserXp);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const snapshots: number[] = [];
  const timer = setTimeout(release, 5_000);
  const cleanup = () => { clearTimeout(timer); release(); };
  vi.spyOn(UserXp, 'findOne').mockImplementation((...args) => {
    const query = findOne(...args); const exec = query.exec.bind(query);
    query.exec = async () => {
      const result = await exec();
      if (query.getFilter().userId?.toString() === userId && snapshots.length < 2) {
        snapshots.push(result!.totalXp);
        if (snapshots.length === 2) cleanup();
        await gate;
      }
      return result;
    };
    return query;
  });
  try {
    const settled = await Promise.allSettled([0, 1].map(() => processMissionReward(userId, mission.id)
      .catch(error => { cleanup(); throw error; })));
    const results = settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
    expect(snapshots).toEqual([0, 0]);
    expect(results.filter(result => result.awarded)).toHaveLength(1);
    expect(results.filter(result => result.duplicate)).toHaveLength(1);
    expect(await XpTransaction.countDocuments({ userId, sourceId: `mission_${mission.id}` })).toBe(1);
    expect((await getUserXp(userId))!.totalXp).toBe(25);
    expect(eventBus.emitXpUpdated).toHaveBeenCalledTimes(1);
  } finally { cleanup(); }
});
