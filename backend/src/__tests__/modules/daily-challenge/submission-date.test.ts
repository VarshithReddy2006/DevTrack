import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  ConnectedPlatform, DailyChallenge, DsaProblem, DsaSubmission, User, UserXp, XpTransaction,
} from '../../../db/models/index.js';
import * as challengeService from '../../../modules/daily-challenge/daily-challenge.service.js';
import { syncPlatform } from '../../../modules/platform-sync/sync.service.js';

const { completionEvent } = vi.hoisted(() => ({ completionEvent: vi.fn() }));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: {
  emitSyncStarted: vi.fn(), emitSyncCompleted: vi.fn(), emitSyncFailed: vi.fn(), emitXpUpdated: vi.fn(),
  emitLevelUp: vi.fn(), emitChallengeCompleted: completionEvent,
} }));
vi.mock('../../../shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateDashboard: vi.fn().mockResolvedValue(undefined), invalidateAllUserCache: vi.fn() } }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { updateFromEvent: vi.fn() } }));
vi.mock('../../../shared/redis/syncLock.service.js', () => ({
  acquireSyncLockWithRetry: vi.fn().mockResolvedValue(true), releaseSyncLock: vi.fn(),
}));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getReadinessDsaQueue: () => ({ add: vi.fn() }) }));
vi.mock('../../../shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), perf: vi.fn() } }));

const userId = '000000000000000000000091';
const username = 'synthetic-challenge';
const now = new Date(Date.UTC(2026, 10, 9, 12));
type Platform = 'leetcode' | 'codeforces';

beforeAll(async () => {
  await Promise.all([DailyChallenge.init(), DsaProblem.init(), DsaSubmission.init(), XpTransaction.init()]);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  await User.create({ _id: userId, clerkId: username, username, email: 'challenge@example.test', displayName: 'Synthetic User' });
  await UserXp.create({ userId });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubProvider(submittedAt: Date) {
  const timestamp = String(submittedAt.getTime() / 1000);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://leetcode.com/graphql') {
      const { query } = JSON.parse(String(init?.body));
      if (query.includes('query recentAcSubmissions')) {
        return Response.json({ data: { recentAcSubmissionList: [{ id: '910001', title: 'Two Sum', titleSlug: 'two-sum', timestamp }] } });
      }
      if (query.includes('query userProfile')) {
        return Response.json({ data: {
          matchedUser: { submitStatsGlobal: { acSubmissionNum: [{ difficulty: 'All', count: 1 }] }, submissionCalendar: '{}' },
          userContestRanking: null,
        } });
      }
    }
    if (url === 'https://alfa-leetcode-api.onrender.com/' + username + '/contest') {
      return Response.json({ contestHistory: [] });
    }
    if (url.startsWith('https://codeforces.com/api/user.info?')) {
      return Response.json({ status: 'OK', result: [{ handle: username }] });
    }
    if (url.startsWith('https://codeforces.com/api/user.rating?')) {
      return Response.json({ status: 'OK', result: [] });
    }
    if (url.startsWith('https://codeforces.com/api/user.status?')) {
      return Response.json({ status: 'OK', result: [{
        id: 910001, verdict: 'OK', language: 'C++', creationTimeSeconds: Number(timestamp),
        problem: { contestId: 4, index: 'A', name: 'Watermelon' },
      }] });
    }
    return new Response(null, { status: 400 });
  }));
}

async function prepareSync(platform: Platform, submittedAt: Date) {
  const challenge = await DailyChallenge.create({
    date: '2026-11-09', title: platform === 'leetcode' ? 'Two Sum' : 'Watermelon',
    titleSlug: platform === 'leetcode' ? 'two-sum' : '4-a',
    description: 'Synthetic challenge', difficulty: 'easy', platform,
    problemUrl: 'https://example.test/problem', xpReward: 30, completionCount: 0,
  });
  await ConnectedPlatform.create({ userId, platformName: platform, username, profileUrl: 'https://example.test/user' });
  stubProvider(submittedAt);

  // Await the background completion check without replacing its real implementation.
  const original = challengeService.checkChallengeCompletion;
  const checks: Promise<boolean>[] = [];
  vi.spyOn(challengeService, 'checkChallengeCompletion').mockImplementation((...args) => {
    const check = original(...args);
    checks.push(check);
    return check;
  });
  return {
    challenge,
    async sync() {
      expect(await syncPlatform(userId, platform)).toMatchObject({ success: true });
      await Promise.all(checks);
      expect(await DsaSubmission.find({ userId, platform }).lean()).toMatchObject([
        { status: 'accepted', submittedAt, externalId: '910001' },
      ]);
    },
  };
}

async function expectCompletion(challengeId: string, completed: boolean) {
  const awards = await XpTransaction.find({ userId, sourceType: 'challenge_completed', sourceId: challengeId }).lean();
  const view = await challengeService.getTodayChallenge(userId);
  expect(awards.map(row => row.xpAwarded)).toEqual(completed ? [30] : []);
  expect((await UserXp.findOne({ userId }).lean())?.totalXp).toBe(completed ? 30 : 0);
  expect(view.userCompleted).toBe(completed);
  expect(view.challenge.completionCount).toBe(completed ? 1 : 0);
  expect(completionEvent).toHaveBeenCalledTimes(completed ? 1 : 0);
}

it.each(['leetcode', 'codeforces'] as const)('imports a historical %s attempt without rewarding today', async platform => {
  const { sync, challenge } = await prepareSync(platform, new Date(Date.UTC(2026, 10, 2, 12)));
  await sync();
  await expectCompletion(challenge.id, false);
});

it.each(['leetcode', 'codeforces'] as const)('rewards a matching %s attempt at the start of today only once', async platform => {
  const { sync, challenge } = await prepareSync(platform, new Date(Date.UTC(2026, 10, 9, 0)));
  await sync();
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 9, 12, 10)));
  await sync();
  await expectCompletion(challenge.id, true);
});

it.each([
  new Date(Date.UTC(2026, 10, 8, 23, 59, 59)),
  new Date(Date.UTC(2026, 10, 10, 0)),
])('does not reward a matching attempt on the other side of a day boundary (%s)', async submittedAt => {
  const { sync, challenge } = await prepareSync('leetcode', submittedAt);
  await sync();
  await expectCompletion(challenge.id, false);
});
