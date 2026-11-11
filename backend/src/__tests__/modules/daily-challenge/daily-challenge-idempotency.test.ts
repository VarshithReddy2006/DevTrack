import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { User, UserXp, UserAnalytics, XpTransaction, DailyChallenge, DsaProblem, DsaSubmission } from '../../../db/models/index.js';
import { checkChallengeCompletion, getTodayChallenge } from '../../../modules/daily-challenge/daily-challenge.service.js';
import challengeRoutes from '../../../modules/daily-challenge/daily-challenge.routes.js';
import { errorHandler } from '../../../middleware/error.js';
import { eventBus } from '../../../shared/sse/index.js';

const auth = vi.hoisted(() => ({ verify: vi.fn() }));
// Keep auth middleware, routes, controller, services, XP processor and MongoDB real.
// Only the identity provider and infrastructure fan-out are external boundaries.
vi.mock('@clerk/backend', () => ({ verifyToken: auth.verify }));
vi.mock('../../../services/auth/ClerkUserSyncService.js', () => ({ syncClerkUser: vi.fn() }));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: {
  emitXpUpdated: vi.fn(), emitLevelUp: vi.fn(),
  emitChallengeCompleted: vi.fn().mockResolvedValue(undefined),
} }));
vi.mock('../../../shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateAllUserCache: vi.fn() } }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { updateFromEvent: vi.fn() } }));
vi.mock('../../../shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const ownerId = '000000000000000000000024';
const otherId = '000000000000000000000025';
const now = new Date('2026-10-28T12:00:00Z');
const realNow = Date.now;
const cleanups: Array<() => void> = [];
let server: Server;
let url: string;

beforeAll(async () => {
  await Promise.all([User.init(), UserXp.init(), UserAnalytics.init(), XpTransaction.init(), DailyChallenge.init(), DsaProblem.init(), DsaSubmission.init()]);
  const app = express();
  app.use('/api/v1/daily-challenge', challengeRoutes);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    const onError = (error: Error) => { listener.off('listening', onListening); reject(error); };
    const onListening = () => { listener.off('error', onError); resolve(listener); };
    listener.once('error', onError);
    listener.once('listening', onListening);
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/daily-challenge/today`;
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_daily_challenge');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  // Freeze calendar dates, but keep MongoDB heartbeat/session liveness on real time.
  vi.spyOn(Date, 'now').mockImplementation(realNow);
  auth.verify.mockImplementation(async (token: string) => {
    if (token !== 'owner' && token !== 'other') throw new Error('Invalid synthetic token');
    return { sub: `clerk_${token}` };
  });
  await User.create([
    { _id: ownerId, clerkId: 'clerk_owner', username: 'challengeowner', email: 'owner@example.test', displayName: 'Owner' },
    { _id: otherId, clerkId: 'clerk_other', username: 'challengeother', email: 'other@example.test', displayName: 'Other' },
  ]);
  await UserXp.create([{ userId: ownerId }, { userId: otherId }]);
});
afterEach(() => {
  cleanups.splice(0).forEach(release => release());
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs();
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function seedChallenge(completionCount = 0) {
  return DailyChallenge.create({ date: '2026-10-28', title: 'Two Sum', titleSlug: 'two-sum', description: 'Synthetic fixture',
    difficulty: 'easy', platform: 'leetcode', problemUrl: 'https://leetcode.com/problems/two-sum/', xpReward: 30, completionCount });
}
async function seedSolve(userId = ownerId, status: 'accepted' | 'wrong' = 'accepted', titleSlug = 'two-sum') {
  const problem = await DsaProblem.create({ userId, externalId: titleSlug, title: 'Synthetic problem', platform: 'leetcode',
    difficulty: 'easy', category: 'arrays', url: 'https://leetcode.com/problems/two-sum/', status: 'solved' });
  await DsaSubmission.create({ userId, problemId: problem._id, platform: 'leetcode', externalId: `submission-${userId}`,
    language: 'typescript', status, submittedAt: now });
}
async function readToday(token = 'owner') {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
}
async function expectSingleAward(challengeId: string, expectedCount = 1) {
  const transactions = await XpTransaction.find({ userId: ownerId, sourceType: 'challenge_completed', sourceId: challengeId });
  expect(transactions).toHaveLength(1);
  expect(transactions[0].xpAwarded).toBe(30);
  expect((await UserXp.findOne({ userId: ownerId }))!.totalXp).toBe(30);
  expect.soft((await DailyChallenge.findById(challengeId))!.completionCount).toBe(expectedCount);
  expect(eventBus.emitChallengeCompleted).toHaveBeenCalledTimes(1);
}

function holdAbsentCompletionReads(participants: number) {
  const findOne = XpTransaction.findOne.bind(XpTransaction);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const absent: boolean[] = [];
  // Bound waiting even if a participant fails before reaching its precheck.
  const timer = setTimeout(release, 5_000);
  const cleanup = () => { clearTimeout(timer); release(); };
  cleanups.push(cleanup);
  vi.spyOn(XpTransaction, 'findOne').mockImplementation((...args) => {
    const query = findOne(...args);
    const exec = query.exec.bind(query);
    query.exec = async () => {
      const result = await exec(); // actual MongoDB query and snapshot
      if (query.getFilter().sourceType === 'challenge_completed' && !query.mongooseOptions().lean && absent.length < participants) {
        absent.push(result === null);
        if (absent.length === participants) cleanup();
        await gate;
      }
      return result;
    };
    return query;
  });
  return { absent, release: cleanup };
}

it.each([2, 3])('admits only one completion from %i overlapping checks', async participants => {
  const challenge = await seedChallenge();
  const barrier = holdAbsentCompletionReads(participants);
  let results: boolean[];
  try {
    results = await Promise.all(Array.from({ length: participants }, () =>
      checkChallengeCompletion(ownerId, 'leetcode', 'two-sum', now).catch(error => { barrier.release(); throw error; })));
  } finally { barrier.release(); }
  expect(barrier.absent).toEqual(Array(participants).fill(true));
  await expectSingleAward(challenge.id);
  expect(results.filter(Boolean)).toHaveLength(1);
});

it('deduplicates overlapping authenticated HTTP reads and preserves completed responses', async () => {
  const challenge = await seedChallenge(); await seedSolve();
  const barrier = holdAbsentCompletionReads(2);
  let responses: Awaited<ReturnType<typeof readToday>>[];
  try {
    responses = await Promise.all(Array.from({ length: 2 }, () => readToday().catch(error => { barrier.release(); throw error; })));
  } finally { barrier.release(); }
  expect(barrier.absent).toEqual([true, true]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect(responses.every(response => response.body.data.userCompleted === true)).toBe(true);
  await expectSingleAward(challenge.id);
  const readback = await readToday();
  expect(readback.body.data).toMatchObject({ userCompleted: true, challenge: { completionCount: 1 } });
  await expectSingleAward(challenge.id);
});

it.each([0, 180])('returns a fresh count on the first successful HTTP read starting at %i', async initial => {
  const challenge = await seedChallenge(initial); await seedSolve();
  const response = await readToday();
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ userCompleted: true, challenge: { completionCount: initial + 1 } });
  await expectSingleAward(challenge.id, initial + 1);
});

it('leaves a sequential completion replay inert', async () => {
  const challenge = await seedChallenge();
  expect(await checkChallengeCompletion(ownerId, 'LEETCODE', 'TWO-SUM', now)).toBe(true);
  expect(await checkChallengeCompletion(ownerId, 'leetcode', 'two-sum', now)).toBe(false);
  expect((await getTodayChallenge(ownerId)).userCompleted).toBe(true);
  await expectSingleAward(challenge.id);
});

it('counts two different users independently', async () => {
  const challenge = await seedChallenge(180);
  expect(await checkChallengeCompletion(ownerId, 'leetcode', 'two-sum', now)).toBe(true);
  expect(await checkChallengeCompletion(otherId, 'leetcode', 'two-sum', now)).toBe(true);
  expect((await DailyChallenge.findById(challenge._id))!.completionCount).toBe(182);
  expect(await XpTransaction.countDocuments({ sourceType: 'challenge_completed', sourceId: challenge.id })).toBe(2);
  expect((await UserXp.findOne({ userId: ownerId }))!.totalXp).toBe(30);
  expect((await UserXp.findOne({ userId: otherId }))!.totalXp).toBe(30);
  expect(eventBus.emitChallengeCompleted).toHaveBeenCalledTimes(2);
});

it.each(['wrong', 'wrong-slug', 'other-owner'] as const)('does not award for a %s submission', async scenario => {
  const challenge = await seedChallenge();
  await seedSolve(scenario === 'other-owner' ? otherId : ownerId,
    scenario === 'wrong' ? 'wrong' : 'accepted', scenario === 'wrong-slug' ? 'another-problem' : 'two-sum');
  expect((await readToday()).body.data.userCompleted).toBe(false);
  expect((await DailyChallenge.findById(challenge._id))!.completionCount).toBe(0);
  expect(await XpTransaction.countDocuments({})).toBe(0);
  expect(eventBus.emitChallengeCompleted).not.toHaveBeenCalled();
});

it('preserves missing-challenge and unauthenticated behavior', async () => {
  expect(await checkChallengeCompletion(ownerId, 'leetcode', 'two-sum', now)).toBe(false);
  expect((await fetch(url)).status).toBe(401);
  expect((await readToday('invalid')).status).toBe(401);
  expect(await DailyChallenge.countDocuments({})).toBe(0);
  expect(await XpTransaction.countDocuments({})).toBe(0);
});


it.each(['beginner', 'advanced'])('isolates all three tiers when %s visits first', async first => {
  await UserAnalytics.create({ userId: otherId, currentStreak: 35 });
  const mediumId = '000000000000000000000026';
  await User.create({ _id: mediumId, clerkId: 'clerk_medium', username: 'challengemedium',
    email: 'medium@example.test', displayName: 'Medium', timezone: 'UTC' });
  await UserAnalytics.create({ userId: mediumId, currentStreak: 14 });
  if (first === 'advanced') await getTodayChallenge(otherId);
  else await getTodayChallenge(ownerId);
  const [easy, medium, hard] = await Promise.all([
    getTodayChallenge(ownerId), getTodayChallenge(mediumId), getTodayChallenge(otherId),
  ]);
  expect([easy.challenge, medium.challenge, hard.challenge].map(c => [c.date, c.difficulty, c.xpReward]))
    .toEqual([['2026-10-28', 'easy', 30], ['2026-10-28', 'medium', 50], ['2026-10-28', 'hard', 80]]);
  expect(await DailyChallenge.countDocuments({ date: '2026-10-28' })).toBe(3);
  expect(await checkChallengeCompletion(ownerId, hard.challenge.platform, hard.challenge.titleSlug, now)).toBe(false);
  for (const [id, view] of [[ownerId, easy], [mediumId, medium], [otherId, hard]] as const) {
    const c = view.challenge;
    expect(await checkChallengeCompletion(id, c.platform, c.titleSlug, now)).toBe(true);
    expect(await checkChallengeCompletion(id, c.platform, c.titleSlug, now)).toBe(false);
    expect((await UserXp.findOne({ userId: id }))!.totalXp).toBe(c.xpReward);
    expect((await getTodayChallenge(id)).userCompleted).toBe(true);
    expect((await DailyChallenge.findById(c._id))!.completionCount).toBe(1);
  }
  expect(await XpTransaction.countDocuments({ sourceType: 'challenge_completed' })).toBe(3);
});

it('converges concurrent first reads on one document per tier', async () => {
  await UserAnalytics.create({ userId: otherId, currentStreak: 35 });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => getTodayChallenge(i % 2 ? ownerId : otherId)));
  expect(new Set(results.map(r => r.challenge.id)).size).toBe(2);
  expect(await DailyChallenge.countDocuments({ date: '2026-10-28' })).toBe(2);
  expect(await XpTransaction.countDocuments({})).toBe(0);
});

it('uses different local dates at the same instant and local weekends for adaptation', async () => {
  vi.setSystemTime(new Date('2026-11-09T00:30:00Z'));
  await User.findByIdAndUpdate(ownerId, { timezone: 'America/Los_Angeles' });
  await User.findByIdAndUpdate(otherId, { timezone: 'Asia/Tokyo' });
  await UserAnalytics.create([{ userId: ownerId, currentStreak: 35 }, { userId: otherId, currentStreak: 35 }]);
  const la = await getTodayChallenge(ownerId);
  const tokyo = await getTodayChallenge(otherId);
  expect(la.challenge).toMatchObject({ date: '2026-11-08', difficulty: 'medium' });
  expect(tokyo.challenge).toMatchObject({ date: '2026-11-09', difficulty: 'hard' });
});

it.each(['', 'not/a-timezone'])('falls back to UTC for invalid or missing timezone %s', async timezone => {
  vi.setSystemTime(new Date('2026-10-28T00:30:00Z'));
  await User.findByIdAndUpdate(ownerId, { timezone });
  expect((await getTodayChallenge(ownerId)).challenge.date).toBe('2026-10-28');
});

it.each([
  { timezone: 'Asia/Tokyo', instant: '2026-11-09T16:00:00Z', date: '2026-11-10',
    start: '2026-11-09T15:00:00Z', end: '2026-11-10T15:00:00Z' },
  { timezone: 'America/Los_Angeles', instant: '2026-11-10T07:30:00Z', date: '2026-11-09',
    start: '2026-11-09T08:00:00Z', end: '2026-11-10T08:00:00Z' },
  { timezone: 'America/Los_Angeles', instant: '2026-03-08T12:00:00Z', date: '2026-03-08',
    start: '2026-03-08T08:00:00Z', end: '2026-03-09T07:00:00Z' },
  { timezone: 'America/Los_Angeles', instant: '2026-11-01T12:00:00Z', date: '2026-11-01',
    start: '2026-11-01T07:00:00Z', end: '2026-11-02T08:00:00Z' },
])('awards only within the local solve window in $timezone on $date', async spec => {
  vi.setSystemTime(new Date(spec.instant));
  await User.findByIdAndUpdate(ownerId, { timezone: spec.timezone });
  const { challenge } = await getTodayChallenge(ownerId);
  expect(challenge.date).toBe(spec.date);
  // The callback must apply the same half-open local day as the database read.
  expect(await checkChallengeCompletion(ownerId, challenge.platform, challenge.titleSlug,
    new Date(new Date(spec.start).getTime() - 1))).toBe(false);
  expect(await checkChallengeCompletion(ownerId, challenge.platform, challenge.titleSlug, new Date(spec.end))).toBe(false);
  const problem = await DsaProblem.create({ userId: ownerId, externalId: challenge.titleSlug,
    title: challenge.title, platform: challenge.platform, difficulty: challenge.difficulty,
    category: 'arrays', url: challenge.problemUrl, status: 'solved' });
  const submission = await DsaSubmission.create({ userId: ownerId, problemId: problem._id,
    platform: challenge.platform, externalId: 'boundary-submission', language: 'typescript',
    status: 'accepted', submittedAt: new Date(new Date(spec.start).getTime() - 1) });
  expect((await getTodayChallenge(ownerId)).userCompleted).toBe(false);
  await DsaSubmission.findByIdAndUpdate(submission._id, { submittedAt: new Date(spec.end) });
  expect((await getTodayChallenge(ownerId)).userCompleted).toBe(false);
  await DsaSubmission.findByIdAndUpdate(submission._id, { submittedAt: new Date(spec.start) });
  expect((await getTodayChallenge(ownerId)).userCompleted).toBe(true);
  expect(await checkChallengeCompletion(ownerId, challenge.platform, challenge.titleSlug, new Date(spec.start))).toBe(false);
  await expectSingleAward(challenge.id);
});
