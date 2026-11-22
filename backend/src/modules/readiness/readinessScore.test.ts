import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import express, { Router } from 'express';
import type { Server } from 'node:http';
import { entries, redis } from '../../__tests__/fixtures/cacheRedis.js';
import { calculateCompositeReadiness as calculate, readinessWeekStart, readinessScoreSchema, type ReadinessScoreInputs } from './readinessScore.calculation.js';
import { getReadinessScore, loadReadinessScoreInputs, persistWeeklyReadiness, readinessScoreCacheKey, readinessScoreSources } from './readinessScore.service.js';
import { ReadinessSnapshot } from '../../db/models/readinessSnapshot.model.js';
import { ReadinessDsa } from '../../db/models/readinessDsa.model.js';
import { ReadinessProjects } from '../../db/models/readinessProjects.model.js';
import { ReadinessInput } from '../../db/models/readinessInput.model.js';
import { DsaContest } from '../../db/models/dsaContest.model.js';
import { mountApiRoutes } from '../../routes/mount.js';
import { readinessRoutes } from './readiness.routes.js';

vi.mock('../../shared/redis/client.js', async original => ({ ...await original<object>(), getRedisClient: () => redis, isRedisConfigured: () => false }));
vi.mock('../../middleware/auth.js', () => ({ authMiddleware: (req: any, res: any, next: any) => {
  const id = req.headers.authorization?.replace('Bearer ', '');
  if (!id || !/^[a-f0-9]{24}$/.test(id)) return res.status(401).json({ success: false });
  req.user = { id }; next();
} }));
vi.mock('./engine/ReadinessOrchestratorService.js', () => ({
  ReadinessOrchestratorService: { computeDynamicSnapshot: vi.fn(async () => ({ overallScore: 73, legacy: true })) },
  DomainIntelligenceService: {},
}));
vi.mock('../flags/flags.service.js', () => ({ isFlagEnabled: vi.fn(async () => false) }));

const OWNER = '507f1f77bcf86cd799439011';
const OTHER = '507f1f77bcf86cd799439012';
const NOW = new Date('2026-11-19T12:00:00.000Z');
const DAY = 86_400_000;
function input(level = 100): ReadinessScoreInputs {
  return {
    dsa: { computedAt: NOW, difficultyDistribution: { easy: 0, medium: 0, hard: 200 } },
    projects: { computedAt: NOW, evidenceCoverage: 100, projectCredibilityScore: level,
      infrastructureSophistication: level, deploymentEvidence: level,
      complexityMetrics: { architectureSophistication: level, repositoryQuality: level, contributionConsistency: level },
      communicationSignals: { documentationQuality: level } },
    contests: [{ rating: 3000, observedAt: NOW }], revision: { reviews: 20, lapses: 0 },
    interviews: [{ userId: OWNER, sessionId: 'session', completedAt: NOW, mode: 'ai', rubricScores: [level, level, level, level] }],
  };
}
const empty = (): ReadinessScoreInputs => ({ dsa: null, projects: null, contests: [], revision: { reviews: 0, lapses: 0 }, interviews: null });

beforeAll(async () => { await Promise.all([ReadinessSnapshot.init(), ReadinessDsa.init(), ReadinessProjects.init(), ReadinessInput.init(), DsaContest.init()]); });
beforeEach(() => { entries.clear(); redis.status = 'ready'; redis.mget.mockReset(); redis.eval.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('composite calculation', () => {
  it('scores beginner, mid-level and advanced candidates without redistributing missing weights', () => {
    const beginner = empty(); beginner.dsa = { computedAt: NOW, difficultyDistribution: { easy: 3, medium: 0, hard: 0 } };
    expect(calculate(OWNER, beginner, NOW)).toMatchObject({ overallScore: 1, dsaScore: 4, isDegraded: true });
    const mid = input(50); mid.dsa!.difficultyDistribution = { easy: 20, medium: 40, hard: 20 };
    mid.contests[0].rating = 1500; mid.revision = { reviews: 10, lapses: 2 };
    expect(calculate(OWNER, mid, NOW)).toMatchObject({ overallScore: 463, dsaScore: 377, systemDesignScore: 500, projectScore: 500, interviewScore: 500, completeness: 100, isDegraded: false });
    expect(calculate(OWNER, input(), NOW)).toMatchObject({ overallScore: 1000, completeness: 100, missingDimensions: [] });
    const unavailable = input(); unavailable.interviews = null;
    expect(calculate(OWNER, unavailable, NOW)).toMatchObject({ overallScore: 800, completeness: 80, missingDimensions: ['interview'] });
    expect(calculate(OWNER, empty(), NOW)).toMatchObject({ overallScore: 0, completeness: 0, evidence: { interview: { status: 'unavailable' } } });
  });

  it.each([-1, NaN, Infinity, 1e12])('rejects malformed solve counts %s without awarding placeholder points', value => {
    const candidate = empty(); candidate.dsa = { computedAt: NOW, difficultyDistribution: { easy: value, medium: 0, hard: 0 } };
    expect(calculate(OWNER, candidate, NOW)).toMatchObject({ overallScore: 0, evidence: { dsa: { status: 'invalid' } } });
  });

  it('expires evidence after seven days and rejects future dates and unverified projects', () => {
    const candidate = input(); candidate.dsa!.computedAt = candidate.projects!.computedAt = new Date(NOW.getTime() - 7 * DAY);
    expect(calculate(OWNER, candidate, NOW).projectScore).toBe(1000);
    candidate.projects!.computedAt = new Date(NOW.getTime() - 7 * DAY - 1);
    expect(calculate(OWNER, candidate, NOW)).toMatchObject({ projectScore: 0, evidence: { projects: { status: 'stale' } } });
    candidate.projects!.computedAt = new Date(NOW.getTime() + 1);
    expect(calculate(OWNER, candidate, NOW).evidence.projects.status).toBe('invalid');
    candidate.projects!.computedAt = NOW; candidate.projects!.evidenceCoverage = 0;
    expect(calculate(OWNER, candidate, NOW).systemDesignScore).toBe(0);
  });

  it('uses only recent owned AI interviews, deduplicates sessions and caps the sample at ten', () => {
    const candidate = empty(); const sample = input().interviews![0];
    candidate.interviews = [
      ...Array.from({ length: 10 }, (_, i) => ({ ...sample, sessionId: `valid-${i}`, completedAt: new Date(NOW.getTime() - i) })),
      { ...sample, sessionId: 'old-valid', completedAt: new Date(NOW.getTime() - DAY), rubricScores: [0, 0, 0, 0] },
      { ...sample, sessionId: 'valid-0', completedAt: new Date(NOW.getTime() - 100), rubricScores: [0, 0, 0, 0] },
      { ...sample, userId: OTHER, sessionId: 'foreign', rubricScores: [0, 0, 0, 0] },
      { ...sample, sessionId: 'basic', mode: 'basic_mode', rubricScores: [0, 0, 0, 0] },
      { ...sample, sessionId: 'stale', completedAt: new Date(NOW.getTime() - 31 * DAY), rubricScores: [0, 0, 0, 0] },
      { ...sample, sessionId: 'future', completedAt: new Date(NOW.getTime() + 1), rubricScores: [0, 0, 0, 0] },
    ];
    expect(calculate(OWNER, candidate, NOW)).toMatchObject({ interviewScore: 1000, overallScore: 200 });
    candidate.interviews = [{ ...sample, rubricScores: [20, 40, 60, 80] }];
    expect(calculate(OWNER, candidate, NOW).interviewScore).toBe(500);
  });

  it('rejects inconsistent response payloads before caching or persistence', () => {
    const score = calculate(OWNER, input(), NOW);
    for (const mutation of [{ overallScore: 999 }, { completeness: 99 }, { missingDimensions: ['dsa'] }, { weekStart: NOW.toISOString() }, { userId: 'bad' }, { computedAt: 'invalid' }]) {
      expect(readinessScoreSchema.safeParse({ ...score, ...mutation }).success).toBe(false);
    }
  });

  it.each([['2027-01-03T23:59:59Z', '2026-12-28T00:00:00.000Z'], ['2027-01-04T00:00:00Z', '2027-01-04T00:00:00.000Z']])('uses UTC Monday weeks at %s', (date, expected) => {
    expect(readinessWeekStart(new Date(date)).toISOString()).toBe(expected);
  });
});

describe('Mongo sources, weekly history and Redis boundary', () => {
  it('combines persisted intelligence with the interview adapter and stores the full breakdown', async () => {
    const candidate = input();
    await ReadinessDsa.create({ userId: OWNER, ...candidate.dsa });
    await ReadinessProjects.create({ userId: OWNER, ...candidate.projects });
    await ReadinessInput.create({ userId: new Types.ObjectId(OWNER), revisionDays: { '2026-11-19': { reviews: 20, lapses: 0 } } });
    await DsaContest.create({ userId: OWNER, contestName: 'recent', platform: 'leetcode', kind: 'participated', ratingAfter: 3000, participatedAt: NOW });
    const adapter = vi.spyOn(readinessScoreSources, 'loadInterviewScores').mockResolvedValue(candidate.interviews);
    const result = await getReadinessScore(OWNER, () => NOW);
    expect(result).toMatchObject({ overallScore: 1000, systemDesignScore: 1000, projectScore: 1000, interviewScore: 1000 });
    expect(adapter).toHaveBeenCalledWith(OWNER, new Date(NOW.getTime() - 30 * DAY), 10);
    expect((await ReadinessSnapshot.findOne().lean())?.result).toEqual(result);
  });

  it('reads owned recent sources, latest rating per platform, and the seven UTC revision buckets', async () => {
    await ReadinessDsa.create({ userId: OWNER, computedAt: NOW, difficultyDistribution: { easy: 20, medium: 40, hard: 20 } });
    await ReadinessProjects.create({ userId: OTHER, computedAt: NOW, evidenceCoverage: 100 });
    await ReadinessInput.create({ userId: new Types.ObjectId(OWNER), revisionDays: {
      '2026-11-19': { reviews: 4, lapses: 1 }, '2026-11-13': { reviews: 6, lapses: 1 }, '2026-11-12': { reviews: 100, lapses: 0 }, '2026-11-20': { reviews: 100, lapses: 0 },
    } });
    const base = { userId: new Types.ObjectId(OWNER), contestName: 'contest', platform: 'codeforces', kind: 'participated', ratingAfter: 1500, participatedAt: NOW };
    await DsaContest.create([base, { ...base, ratingAfter: 3000, participatedAt: new Date(NOW.getTime() - DAY) },
      { ...base, userId: new Types.ObjectId(OTHER), ratingAfter: 4000 }, { ...base, kind: 'scheduled', ratingAfter: 5000 },
      { ...base, participatedAt: new Date(NOW.getTime() + DAY) }, { ...base, platform: 'other', ratingAfter: 9000 }]);
    const loaded = await loadReadinessScoreInputs(OWNER, NOW);
    expect(loaded).toMatchObject({ projects: null, revision: { reviews: 10, lapses: 2 }, interviews: null, contests: [{ rating: 1500, observedAt: NOW }] });
    expect(calculate(OWNER, loaded, NOW).dsaScore).toBe(377);
  });

  it('coalesces requests, caches for one hour, isolates owners and refreshes the same weekly row', async () => {
    let now = NOW; const clock = () => now;
    const source = vi.spyOn(readinessScoreSources, 'loadInterviewScores');
    const scores = await Promise.all(Array.from({ length: 8 }, () => getReadinessScore(OWNER, clock)));
    expect(source).toHaveBeenCalledTimes(1); expect(scores.every(s => s.overallScore === 0)).toBe(true);
    expect(await ReadinessSnapshot.countDocuments()).toBe(1);
    const key = readinessScoreCacheKey(OWNER, readinessWeekStart(NOW).toISOString());
    expect(entries.get(key)?.expires).toBeGreaterThan(Date.now() + 3_599_000);
    await getReadinessScore(OWNER.toUpperCase(), clock); expect(source).toHaveBeenCalledTimes(1);
    await getReadinessScore(OTHER, clock); expect(source).toHaveBeenCalledTimes(2);
    now = new Date(NOW.getTime() + 3_600_000);
    await getReadinessScore(OWNER, clock); expect(source).toHaveBeenCalledTimes(3);
    expect(await ReadinessSnapshot.countDocuments({ userId: OWNER })).toBe(1);
    now = new Date('2026-11-23T00:00:00Z'); await getReadinessScore(OWNER, clock);
    expect(await ReadinessSnapshot.countDocuments({ userId: OWNER })).toBe(2);
  });

  it('keeps one row under concurrent writes and never rolls a newer observation back', async () => {
    const older = calculate(OWNER, empty(), NOW);
    const newer = calculate(OWNER, input(), new Date(NOW.getTime() + 100));
    await Promise.all(Array.from({ length: 8 }, () => persistWeeklyReadiness(newer)));
    await persistWeeklyReadiness(older);
    expect(await ReadinessSnapshot.countDocuments()).toBe(1);
    expect((await ReadinessSnapshot.findOne().lean())?.overallScore).toBe(1000);
  });

  it.each(['foreign', 'inconsistent', 'malformed'])('rebuilds %s cached data without leaking it', async kind => {
    const score = calculate(kind === 'foreign' ? OTHER : OWNER, input(), NOW);
    const value = kind === 'malformed' ? '{' : JSON.stringify({ ...score, ...(kind === 'inconsistent' ? { overallScore: 999 } : {}) });
    entries.set(readinessScoreCacheKey(OWNER, score.weekStart), { value });
    expect(await getReadinessScore(OWNER, () => NOW)).toMatchObject({ userId: OWNER, overallScore: 0 });
    expect(await ReadinessSnapshot.countDocuments()).toBe(1);
  });

  it.each(['disconnected', 'read-failure', 'write-failure'])('falls back to Mongo on Redis %s', async kind => {
    if (kind === 'disconnected') redis.status = 'end';
    if (kind === 'read-failure') redis.mget.mockRejectedValue(new Error('offline'));
    if (kind === 'write-failure') redis.eval.mockRejectedValue(new Error('offline'));
    expect((await getReadinessScore(OWNER, () => NOW)).overallScore).toBe(0);
    expect(await ReadinessSnapshot.countDocuments()).toBe(1);
  });

  it('propagates source and history failures instead of caching invented zero scores', async () => {
    const source = vi.spyOn(readinessScoreSources, 'loadInterviewScores').mockRejectedValueOnce(new Error('source down'));
    await expect(getReadinessScore(OWNER, () => NOW)).rejects.toThrow('source down');
    expect(entries.size).toBe(0); expect(await ReadinessSnapshot.countDocuments()).toBe(0);
    source.mockResolvedValue(null);
    vi.spyOn(ReadinessSnapshot, 'updateOne').mockRejectedValueOnce(new Error('history down'));
    await expect(getReadinessScore(OWNER, () => NOW)).rejects.toThrow('history down');
    expect(entries.size).toBe(0);
  });
});

describe('HTTP routing and compatibility', () => {
  let server: Server; let url: string;
  beforeAll(async () => {
    const app = express(); const routes = Router(); routes.use('/readiness', readinessRoutes); mountApiRoutes(app, routes);
    server = await new Promise<Server>(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => { server.closeIdleConnections(); });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  it('serves an owner-scoped radar and ignores a foreign query identity', async () => {
    const now = new Date();
    await ReadinessDsa.create({userId:OTHER,computedAt:now,topics:[{name:'array',masteryLevel:99,evidenceCoverage:100,recency:now}]});
    await ReadinessDsa.create({userId:OWNER,computedAt:now,topics:[{name:'array',masteryLevel:30,evidenceCoverage:100,recency:now}]});
    expect((await fetch(`${url}/api/v1/readiness/placement-radar`)).status).toBe(401);
    const response=await fetch(`${url}/api/v1/readiness/placement-radar?userId=${OTHER}`,{headers:{authorization:`Bearer ${OWNER}`}});
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
    const {data}=await response.json();expect(data.axes[0].score).toBe(30);expect(data.axes[4].score).toBeNull();expect(data.plan).toHaveLength(7);
  });
  it('requires auth and serves an owner-scoped private v2 score; keeps the old snapshot contract', async () => {
    expect((await fetch(`${url}/api/v2/readiness/score`)).status).toBe(401);
    const headers = { authorization: `Bearer ${OWNER}` };
    const response = await fetch(`${url}/api/v2/readiness/score?userId=${OTHER}`, { headers });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).data).toMatchObject({ userId: OWNER, scale: 1000, interviewScore: 0 });
    const legacy = await fetch(`${url}/api/v1/readiness/snapshot`, { headers });
    expect(await legacy.json()).toEqual({ success: true, data: { overallScore: 73, legacy: true } });
    expect((await fetch(`${url}/api/v2/readiness/snapshot`, { headers })).status).toBe(404);
    expect((await fetch(`${url}/api/v2/readiness/score`, { method: 'POST', headers })).status).toBe(404);
  });
});
