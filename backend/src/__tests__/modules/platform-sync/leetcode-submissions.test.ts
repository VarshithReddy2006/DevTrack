import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ConnectedPlatform, DsaProblem, DsaSubmission } from '../../../db/models/index.js';
import { getSubmissions } from '../../../modules/dsa/dsa.service.js';
import { ingestLeetCodeSubmissions, syncPlatform } from '../../../modules/platform-sync/sync.service.js';

vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: { emitSyncCompleted: vi.fn(), emitSyncFailed: vi.fn() },
}));
vi.mock('../../../shared/redis/syncLock.service.js', () => ({
  acquireSyncLockWithRetry: vi.fn().mockResolvedValue(true),
  releaseSyncLock: vi.fn(),
}));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({
  getReadinessDsaQueue: () => ({ add: vi.fn() }),
}));
vi.mock('../../../modules/daily-challenge/daily-challenge.service.js', () => ({
  checkChallengeCompletion: vi.fn().mockResolvedValue(false),
}));

const userId = '000000000000000000000081';
const username = 'synthetic-leetcode';
const firstAttempt = { id: '900001', title: 'Two Sum', titleSlug: 'two-sum', timestamp: '1794139140' };
const secondAttempt = { ...firstAttempt, id: '900002', timestamp: '1794139200' };
const problemKey = { userId, platform: 'leetcode', externalId: firstAttempt.titleSlug };

beforeAll(async () => {
  await Promise.all([ConnectedPlatform.init(), DsaProblem.init(), DsaSubmission.init()]);
});

afterEach(() => vi.unstubAllGlobals());

function stubProvider(attempts: (typeof firstAttempt)[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'https://leetcode.com/graphql') {
      const { query } = JSON.parse(String(init?.body));
      if (query.includes('query recentAcSubmissions')) {
        return Response.json({ data: { recentAcSubmissionList: attempts } });
      }
      if (query.includes('query userProfile')) {
        return Response.json({
          data: {
            matchedUser: {
              submitStatsGlobal: { acSubmissionNum: [{ difficulty: 'All', count: 1 }, { difficulty: 'Easy', count: 1 }] },
              submissionCalendar: '{}',
            },
            userContestRanking: null,
          },
        });
      }
    }
    if (url === 'https://alfa-leetcode-api.onrender.com/synthetic-leetcode/contest') {
      return Response.json({ contestHistory: [] });
    }
    throw new Error('Unexpected provider request');
  }));
}

function submittedAt(attempt: typeof firstAttempt) {
  return new Date(Number(attempt.timestamp) * 1000);
}

it('imports separate accepted attempts for the same problem during sync', async () => {
  await ConnectedPlatform.create({
    userId,
    platformName: 'leetcode',
    username,
    profileUrl: 'https://leetcode.com/u/synthetic-leetcode/',
  });
  stubProvider([secondAttempt, firstAttempt]);

  expect(await syncPlatform(userId, 'leetcode')).toMatchObject({ success: true });

  const problems = await DsaProblem.find(problemKey).lean();
  expect(problems).toHaveLength(1);
  expect(problems[0].submissionCount).toBe(2);
  const submissions = await DsaSubmission.find({ userId, platform: 'leetcode' }).sort({ externalId: 1 }).lean();
  expect(submissions).toMatchObject([firstAttempt, secondAttempt].map(attempt => ({
    externalId: attempt.id,
    problemId: problems[0]._id,
    status: 'accepted',
    submittedAt: submittedAt(attempt),
  })));
  const history = await getSubmissions(userId, { platform: 'leetcode' });
  expect(history.submissions).toHaveLength(2);

  expect(await ingestLeetCodeSubmissions(userId, username)).toBe(0);
  expect(await DsaSubmission.countDocuments({ userId, platform: 'leetcode' })).toBe(2);
  expect((await DsaProblem.findOne(problemKey).lean())?.submissionCount).toBe(2);
});

it('increments an existing problem once when the provider returns a new attempt alongside a known ID', async () => {
  const problem = await DsaProblem.create({
    ...problemKey,
    title: firstAttempt.title,
    category: 'arrays',
    url: 'https://leetcode.com/problems/two-sum',
    difficulty: 'easy',
    status: 'solved',
    submissionCount: 1,
    lastSubmittedAt: submittedAt(firstAttempt),
  });
  await DsaSubmission.create({
    userId,
    platform: 'leetcode',
    problemId: problem._id,
    externalId: firstAttempt.id,
    status: 'accepted',
    language: 'unknown',
    submittedAt: submittedAt(firstAttempt),
  });
  stubProvider([secondAttempt, firstAttempt]);

  expect(await ingestLeetCodeSubmissions(userId, username)).toBe(1);
  expect((await DsaProblem.findById(problem._id).lean())?.submissionCount).toBe(2);
  const submissions = await DsaSubmission.find({ userId, platform: 'leetcode' }).sort({ externalId: 1 }).lean();
  expect(submissions.map(row => row.externalId)).toEqual([firstAttempt.id, secondAttempt.id]);
});

it('leaves storage empty when the provider returns no submissions', async () => {
  stubProvider([]);

  expect(await ingestLeetCodeSubmissions(userId, username)).toBe(0);
  expect(await DsaProblem.countDocuments({ userId })).toBe(0);
  expect(await DsaSubmission.countDocuments({ userId })).toBe(0);
});
