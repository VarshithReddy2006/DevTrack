import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Mission, User, UserXp, XpTransaction } from '../../../db/models/index.js';
import { generateDailyMissions, generateWeeklyMissions } from '../../../modules/missions/missionGenerator.service.js';
import { getUserMissions, updateMissionProgress } from '../../../modules/missions/missionProgress.service.js';
import { processXpEvent } from '../../../modules/xp/processor.js';
import { XP_LEVEL_THRESHOLDS } from '../../../modules/xp/rules.js';

// Keep generator, matching, completion/rewards, ledger and aggregates real.
// Stub only unrelated delivery, cache and runtime boundaries.
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: {
  emitXpUpdated: vi.fn(), emitLevelUp: vi.fn(), emitMissionProgress: vi.fn(), emitNotificationCreated: vi.fn(),
} }));
vi.mock('../../../shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateDashboard: vi.fn().mockResolvedValue(undefined), invalidateAllUserCache: vi.fn() } }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { updateFromEvent: vi.fn() } }));

const userId = new Types.ObjectId().toHexString();
const now = new Date('2026-11-02T12:00:00Z');
const difficulties = ['easy', 'medium', 'hard'] as const;
type Difficulty = typeof difficulties[number];
const baseXp = { easy: 10, medium: 25, hard: 50 };

beforeAll(async () => {
  // The standard fixture owns MongoDB. Await only the unique ledger index needed
  // for replay assertions, not Mission's unrelated duplicate expiresAt indexes.
  await XpTransaction.init();
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await User.create({ _id: userId, clerkId: 'eligibility-owner', username: 'eligibilityowner', email: 'owner@example.test', displayName: 'Synthetic Owner', lastActiveAt: now });
  await UserXp.create({ userId });
});
afterEach(() => { vi.useRealTimers(); });

async function weeklyContest() {
  await generateWeeklyMissions();
  const contest = await Mission.findOne({ userId, title: 'Participate in a contest' }).lean();
  expect(contest).toMatchObject({ description: 'Join at least one coding contest this week', status: 'pending', currentCount: 0, targetCount: 1, xpReward: 100 });
  return contest!;
}
function solve(sourceId: string, difficulty: Difficulty = 'easy', owner = userId) {
  return processXpEvent({ userId: owner, sourceType: 'dsa_accepted', sourceId, difficulty });
}
async function contestBonuses(missionId: Types.ObjectId) {
  return XpTransaction.find({ userId, sourceType: 'manual', sourceId: `mission_${missionId}` }).lean();
}

describe('generated contest mission eligibility', () => {
  it.each(difficulties)('ordinary %s accepted solve retains only base XP and leaves the contest active', async difficulty => {
    const contest = await weeklyContest();
    await solve(`ordinary-${difficulty}`, difficulty);
    expect.soft(await Mission.findById(contest._id).lean()).toMatchObject({ status: 'pending', currentCount: 0, completedAt: null });
    expect.soft((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(baseXp[difficulty]);
    expect.soft(await contestBonuses(contest._id)).toHaveLength(0);
    expect((await getUserMissions(userId)).find(mission => mission.id === contest._id.toString())).toMatchObject({ status: 'pending', currentCount: 0 });
  });

  it('genuine contest completes once, pays its configured reward and preserves replay idempotency', async () => {
    const contest = await weeklyContest();
    const event = { userId, sourceType: 'dsa_contest' as const, sourceId: 'genuine-contest' };
    await processXpEvent(event);
    expect(await Mission.findById(contest._id).lean()).toMatchObject({ status: 'completed', currentCount: 1, completedAt: now });
    expect((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(140);
    expect(await contestBonuses(contest._id)).toMatchObject([{ xpAwarded: 100 }]);
    expect((await getUserMissions(userId)).some(mission => mission.id === contest._id.toString())).toBe(false);
    expect(await Mission.findOne({ userId, title: /Solve .* problems this week/ }).lean()).toMatchObject({ status: 'pending', currentCount: 0 });

    expect(await processXpEvent(event)).toMatchObject({ duplicate: true, awarded: false });
    expect((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(140);
    expect(await contestBonuses(contest._id)).toHaveLength(1);
    expect(await XpTransaction.countDocuments({ userId })).toBe(2);
  });

  it('a later distinct contest awards its base XP without paying a completed mission again', async () => {
    const contest = await weeklyContest();
    await processXpEvent({ userId, sourceType: 'dsa_contest', sourceId: 'first-contest' });
    const completed = await Mission.findById(contest._id).lean();
    await processXpEvent({ userId, sourceType: 'dsa_contest', sourceId: 'second-contest' });
    expect(await Mission.findById(contest._id).lean()).toEqual(completed);
    expect((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(180);
    expect(await contestBonuses(contest._id)).toHaveLength(1);
  });

  it.each([
    ['JOIN A CONTEST', 'easy'], ['Participate in a medium contest', 'medium'],
  ] as const)('ordinary solves cannot match the existing contest title marker in %j', async (title, difficulty) => {
    const contest = await weeklyContest();
    await Mission.updateOne({ _id: contest._id }, { $set: { title } });
    await solve('contest-title-variant', difficulty);
    expect(await Mission.findById(contest._id).lean()).toMatchObject({ status: 'pending', currentCount: 0, completedAt: null });
    expect(await contestBonuses(contest._id)).toHaveLength(0);
  });

  it.each(['sync', 'streak_day', 'project_task'] as const)('%s activity does not progress a contest mission', async activity => {
    const contest = await weeklyContest();
    await updateMissionProgress(userId, activity);
    expect(await Mission.findById(contest._id).lean()).toMatchObject({ status: 'pending', currentCount: 0, completedAt: null });
    expect(await contestBonuses(contest._id)).toHaveLength(0);
    expect((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(0);
  });

  it.each(['dsa_accepted', 'dsa_contest'] as const)('%s from another user cannot modify the owner mission', async sourceType => {
    const contest = await weeklyContest();
    const before = await Mission.findById(contest._id).lean();
    const otherId = new Types.ObjectId().toHexString();
    await User.create({ _id: otherId, clerkId: 'eligibility-other', username: 'eligibilityother', email: 'other@example.test', displayName: 'Other' });
    await processXpEvent({ userId: otherId, sourceType, sourceId: 'other-event', difficulty: 'easy' });
    expect(await Mission.findById(contest._id).lean()).toEqual(before);
    expect(await contestBonuses(contest._id)).toHaveLength(0);
    expect((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(0);
  });

  it('an expired contest mission is not progressed or rewarded even by a contest event', async () => {
    const contest = await weeklyContest();
    await Mission.updateOne({ _id: contest._id }, { $set: { expiresAt: new Date(now.getTime() - 1) } });
    const before = await Mission.findById(contest._id).lean();
    await processXpEvent({ userId, sourceType: 'dsa_contest', sourceId: 'expired-contest' });
    expect(await Mission.findById(contest._id).lean()).toEqual(before);
    expect(await contestBonuses(contest._id)).toHaveLength(0);
    expect((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(40);
  });
});

describe('ordinary generated solve missions remain eligible', () => {
  const calibration = { easy: 1, medium: 5, hard: 8 };
  async function daily(difficulty: Difficulty) {
    const level = calibration[difficulty];
    await UserXp.updateOne({ userId }, { $set: { totalXp: XP_LEVEL_THRESHOLDS[level], currentLevel: level } });
    await generateDailyMissions();
    const mission = await Mission.findOne({ userId, title: `Solve a ${difficulty} problem` }).lean();
    expect(mission).not.toBeNull();
    return mission!;
  }

  it.each(difficulties)('a matching %s solve progresses both difficulty and count missions', async difficulty => {
    const mission = await daily(difficulty);
    await solve(`matching-${difficulty}`, difficulty);
    expect(await Mission.findById(mission._id).lean()).toMatchObject({ status: 'completed', currentCount: 1, completedAt: now });
    expect(await Mission.findOne({ userId, title: /Solve .* problems today/ }).lean()).toMatchObject({ status: 'in_progress', currentCount: 1 });
    expect((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(XP_LEVEL_THRESHOLDS[calibration[difficulty]] + baseXp[difficulty] + mission.xpReward);
    expect(await contestBonuses(mission._id)).toMatchObject([{ xpAwarded: mission.xpReward }]);
  });

  const mismatches = difficulties.flatMap(required => difficulties.filter(actual => actual !== required).map(actual => [required, actual] as const));
  it.each(mismatches)('%s mission rejects a %s solve while retaining count-mission progress', async (required, actual) => {
    const mission = await daily(required);
    await solve(`mismatch-${required}-${actual}`, actual);
    expect(await Mission.findById(mission._id).lean()).toMatchObject({ status: 'pending', currentCount: 0, completedAt: null });
    expect(await Mission.findOne({ userId, title: /Solve .* problems today/ }).lean()).toMatchObject({ currentCount: 1 });
    expect(await contestBonuses(mission._id)).toHaveLength(0);
    expect((await UserXp.findOne({ userId }).lean())!.totalXp).toBe(XP_LEVEL_THRESHOLDS[calibration[required]] + baseXp[actual]);
  });
});
