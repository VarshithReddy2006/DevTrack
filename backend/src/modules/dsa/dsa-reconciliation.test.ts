import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { DsaProblem, DsaSubmission, DsaTopicProgress, PlatformStats } from '../../db/models/index.js';
import { DSAProfile } from '../../db/models/dsaProfile.model.js';
import { persistSubmissions } from '../platform-sync/sync.persistence.js';
import { dsaProblemIdentity } from './dsa-problem-identity.js';
import { reconcileDsaEvidence } from './dsa-reconciliation.js';
import { createProblem, getDashboard, getStats, getTopicAnalytics, updateProblem } from './dsa.service.js';

describe('canonical DSA problem identity', () => {
  it('matches official provider URLs and IDs across input formats', () => {
    expect(dsaProblemIdentity({ platform: 'other', url: 'https://www.leetcode.com/problems/Two-Sum/description/?source=manual' }))
      .toEqual({ platform: 'leetcode', key: 'leetcode:two-sum' });
    expect(dsaProblemIdentity({ platform: 'codeforces', externalId: '4-A' }).key).toBe(
      dsaProblemIdentity({ platform: 'codeforces', url: 'https://codeforces.com/contest/4/problem/A' }).key,
    );
    expect(dsaProblemIdentity({ platform: 'codechef', url: 'https://www.codechef.com/START1/problems/TEST_1' }).key)
      .toBe('codechef:test_1');
    expect(dsaProblemIdentity({ platform: 'other', url: 'https://leetcode.com.example.test/problems/two-sum' }).key)
      .toBeUndefined();
  });

  it('keeps distinct manual rows without a provider ID and never subtracts verified local solves', () => {
    const result = reconcileDsaEvidence([
      { _id: '1', platform: 'other', externalId: 'manual:1', category: 'Arrays', difficulty: 'easy', status: 'solved' },
      { _id: '2', platform: 'other', externalId: 'manual:2', category: 'Arrays', difficulty: 'easy', status: 'solved' },
      { _id: '3', platform: 'leetcode', externalId: 'two-sum', category: 'Arrays', difficulty: 'easy', status: 'solved' },
    ], new Set(), [{ platformName: 'leetcode', totalSolved: 0, easySolved: 0, mediumSolved: 0, hardSolved: 0 }]);
    expect(result.provenance).toEqual({ manualSolved: 2, syncedSolved: 1, dedupedTotalSolved: 3 });
    expect(result.solvedByDifficulty).toEqual({ easy: 3, medium: 0, hard: 0, unknown: 0 });
  });
});

it('reconciles the dashboard, stats and topic analytics across all sources', async () => {
  const owner = new Types.ObjectId();
  const ownerId = owner.toString();
  const otherUser = new Types.ObjectId();
  const manual = await createProblem(ownerId, {
    title: 'Two Sum', platform: 'other', url: 'https://leetcode.com/problems/two-sum/description/',
    difficulty: 'easy', category: 'Arrays', tags: [],
  });
  await updateProblem(ownerId, manual.id, { status: 'solved' });
  expect((await DsaProblem.findById(manual.id).lean())?.problemKey).toBe('leetcode:two-sum');
  await persistSubmissions(ownerId, ['first', 'second'].map(externalId => ({
    externalId, problemExternalId: 'two-sum', problemUrl: 'https://leetcode.com/problems/two-sum',
    platform: 'leetcode', title: 'Two Sum', category: 'DSA', status: 'accepted',
    difficulty: 'unknown', submittedAt: new Date('2026-01-01T00:00:00Z'),
  })));
  expect(await DsaProblem.findOne({ userId: owner, externalId: 'two-sum' }).lean())
    .toMatchObject({ problemKey: 'leetcode:two-sum', difficultyKnown: false });

  const codeforces = await DsaProblem.create({
    userId: owner, platform: 'codeforces', externalId: '4-A', title: 'Watermelon',
    url: 'https://codeforces.com/problemset/problem/4/A', category: 'Math', difficulty: 'medium', status: 'attempted',
  });
  await DsaProblem.create({
    userId: owner, platform: 'other', externalId: '', title: 'Local solve', url: 'https://example.test/local',
    category: 'Graphs', difficulty: 'hard', status: 'solved',
  });
  const unsolved = await DsaProblem.create({
    userId: owner, platform: 'other', externalId: 'manual:unsolved', title: 'Local unsolved',
    url: 'https://example.test/unsolved', category: 'Graphs', difficulty: 'hard', status: 'unsolved',
  });
  await DsaSubmission.create([
    { userId: owner, problemId: codeforces._id, externalId: 'cf-1' },
    { userId: otherUser, problemId: unsolved._id, externalId: 'foreign' },
  ].map(row => ({ ...row, platform: 'codeforces', status: 'accepted', submittedAt: new Date(), language: 'cpp' })));
  await PlatformStats.create([
    { platformName: 'leetcode', totalSolved: 3, easySolved: 1, mediumSolved: 1, hardSolved: 1 },
    { platformName: 'codechef', totalSolved: 4 },
    { platformName: 'github', totalSolved: 99 },
  ].map(row => ({ ...row, userId: owner, username: 'fixture' })));
  await DSAProfile.create({ userId: ownerId, platform: 'codeforces', totalSolved: 2, easySolved: 1, isVerified: true });
  await DsaTopicProgress.create({ userId: owner, topicName: 'LeetCode Problems', totalProblems: 99, solvedCount: 99 });

  const [dashboard, stats, analytics] = await Promise.all([
    getDashboard(ownerId), getStats(ownerId), getTopicAnalytics(ownerId),
  ]);
  expect(dashboard.stats.find(row => row.label === 'Problems Solved')?.value).toBe('10');
  expect(dashboard.solvedByDifficulty).toEqual({ easy: 2, medium: 2, hard: 2, unknown: 4 });
  expect(dashboard.provenance).toEqual({ manualSolved: 2, syncedSolved: 9, dedupedTotalSolved: 10 });
  expect(dashboard.platformOverview.map(({ platform, totalSolved }) => [platform, totalSolved]))
    .toEqual([['leetcode', 3], ['codeforces', 2], ['codechef', 4]]);
  expect(stats).toMatchObject({ totalSolved: 10, easySolved: 2, mediumSolved: 2, hardSolved: 2, unknownSolved: 4 });
  expect(analytics.summary.totalSolved).toBe(10);
  expect(analytics.summary.totalProblems).toBe(11);
  expect(analytics.topics.reduce((sum, topic) => sum + topic.solvedCount, 0)).toBe(10);
  expect(analytics.topics.find(topic => topic.topicName === 'Arrays')).toMatchObject({ solvedCount: 1 });
  expect(analytics.topics.find(topic => topic.topicName === 'Math')).toMatchObject({ solvedCount: 1 });
});
