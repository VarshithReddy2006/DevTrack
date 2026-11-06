import { beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { DsaProblem } from '../../../db/models/dsaProblem.model.js';
import { DsaSubmission } from '../../../db/models/dsaSubmission.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ConnectedPlatform } from '../../../db/models/connectedPlatform.model.js';
import { DsaIntelligenceEngine } from '../../../modules/readiness/intelligence/DsaIntelligenceEngine.js';

beforeAll(async () => {
  await Promise.all([DsaProblem.init(), DsaSubmission.init(), ReadinessDsa.init(), ConnectedPlatform.init()]);
});

const owner = new Types.ObjectId();
let serial = 0;
async function problem(platform: 'leetcode' | 'codeforces', difficulty = 'easy', tags = ['arrays'], userId = owner) {
  return DsaProblem.create({ userId, platform, externalId: `p-${++serial}`, title: 'Same display title',
    difficulty, tags, category: 'algorithms', url: 'https://example.test/problem' });
}
async function solve(problemId: Types.ObjectId, platform: 'leetcode' | 'codeforces', options: {
  userId?: Types.ObjectId; externalId?: string; status?: string; submittedAt?: Date; topicTags?: string[];
} = {}) {
  return DsaSubmission.create({ userId: options.userId ?? owner, problemId, platform,
    externalId: options.externalId ?? `s-${++serial}`, status: options.status ?? 'accepted',
    submittedAt: options.submittedAt ?? new Date(), topicTags: options.topicTags ?? [], language: 'typescript' });
}
async function generate(platform: 'leetcode' | 'codeforces' | 'codechef' = 'leetcode') {
  await DsaIntelligenceEngine.generateIntelligence({ userId: owner.toHexString(), platform });
  return (await ReadinessDsa.findOne({ userId: owner.toHexString() }).lean())!;
}

describe('whole-user DSA readiness', () => {
  it('retains ten LeetCode solves after five Codeforces solves and either trigger order', async () => {
    for (let i = 0; i < 10; i++) await solve((await problem('leetcode', 'easy', ['arrays']))._id, 'leetcode');
    expect((await generate()).totalSolves).toBe(10);
    for (let i = 0; i < 5; i++) await solve((await problem('codeforces', 'hard', ['graphs']))._id, 'codeforces');
    for (const trigger of ['codeforces', 'leetcode', 'codechef'] as const) {
      const snapshot = await generate(trigger);
      expect(snapshot.totalSolves).toBe(15);
      expect(snapshot.difficultyDistribution).toMatchObject({ easy: 10, medium: 0, hard: 5 });
      expect(snapshot.topics.map(t => t.name).sort()).toEqual(['arrays', 'graphs']);
    }
  });

  it('counts problem identities, not repeated submissions or provider-local submission IDs', async () => {
    const shared = await problem('leetcode', 'hard', ['graphs']);
    const distinct = await problem('codeforces', 'medium', ['dp']);
    await solve(shared._id, 'leetcode', { externalId: '123' });
    await solve(shared._id, 'leetcode', { externalId: '124' });
    await solve(shared._id, 'codeforces', { externalId: '123' });
    await solve(distinct._id, 'codeforces', { externalId: '125' });
    const snapshot = await generate('codeforces');
    expect(snapshot.totalSolves).toBe(2);
    expect(snapshot.difficultyDistribution).toMatchObject({ easy: 0, medium: 1, hard: 1 });
    expect(snapshot.topics.find(t => t.name === 'graphs')?.masteryLevel).toBe(15);
  });

  it('excludes rejected attempts and other users from solves, topics and difficulty', async () => {
    const accepted = await problem('leetcode', 'medium', ['arrays']);
    await solve(accepted._id, 'leetcode');
    for (const status of ['wrong', 'time_limit_exceeded', 'runtime_error', 'compilation_error']) {
      await solve((await problem('codeforces', 'hard', ['failed-only']))._id, 'codeforces', { status });
    }
    const other = new Types.ObjectId();
    await solve((await problem('codeforces', 'hard', ['other-user'], other))._id, 'codeforces', { userId: other });
    const snapshot = await generate();
    expect(snapshot.totalSolves).toBe(1);
    expect(snapshot.difficultyDistribution).toMatchObject({ easy: 0, medium: 1, hard: 0 });
    expect(snapshot.topics.map(t => t.name)).toEqual(['arrays']);
  });

  it('does not merge distinct problems just because titles or local external IDs collide', async () => {
    const first = await problem('leetcode');
    const second = await problem('codeforces');
    await solve(first._id, 'leetcode', { externalId: 'same' });
    await solve(second._id, 'codeforces', { externalId: 'same' });
    expect((await generate()).totalSolves).toBe(2);
  });

  it('unions topic evidence across repeat solves without inflating mastery', async () => {
    const p = await problem('leetcode', 'hard', ['graphs']);
    await solve(p._id, 'leetcode', { topicTags: ['graphs', 'dfs'] });
    await solve(p._id, 'codeforces', { topicTags: ['graphs', 'trees'] });
    const snapshot = await generate();
    expect(snapshot.topics.map(t => t.name).sort()).toEqual(['dfs', 'graphs', 'trees']);
    expect(snapshot.topics.every(t => t.masteryLevel === 15)).toBe(true);
  });

  it('retains per-provider sync freshness, including connected providers without solves', async () => {
    const recent = new Date(), stale = new Date(Date.now() - 60 * 86400000);
    await ConnectedPlatform.create([
      { userId: owner, platformName: 'leetcode', username: 'test', profileUrl: 'https://example.test/lc', lastSyncedAt: stale },
      { userId: owner, platformName: 'codeforces', username: 'test', profileUrl: 'https://example.test/cf', lastSyncedAt: recent },
      { userId: owner, platformName: 'codechef', username: 'test', profileUrl: 'https://example.test/cc', lastSyncedAt: null },
      { userId: owner, platformName: 'github', username: 'test', profileUrl: 'https://example.test/gh', lastSyncedAt: recent },
    ]);
    await solve((await problem('leetcode'))._id, 'leetcode');
    const snapshot = await generate('codeforces');
    expect(Object.keys(snapshot.providerFreshness).sort()).toEqual(['codechef', 'codeforces', 'leetcode']);
    expect(snapshot.providerFreshness.leetcode.lastSync).toEqual(stale);
    expect(snapshot.providerFreshness.leetcode.freshnessScore).toBe(0);
    expect(snapshot.providerFreshness.codeforces.lastSync).toEqual(recent);
    expect(snapshot.providerFreshness.codeforces.freshnessScore).toBe(100);
    expect(snapshot.providerFreshness.codechef.freshnessScore).toBe(0);
    expect(snapshot.confidenceReasoning).not.toContain('Fresh provider data');
  });

  it('keeps a complete zero snapshot for a user without accepted submissions', async () => {
    const snapshot = await generate();
    expect(snapshot.totalSolves).toBe(0);
    expect(snapshot.topics).toEqual([]);
    expect(snapshot.difficultyDistribution).toMatchObject({ easy: 0, medium: 0, hard: 0 });
    expect(snapshot.confidenceScore).toBe(0);
  });
});
