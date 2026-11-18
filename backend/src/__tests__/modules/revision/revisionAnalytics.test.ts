import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisionCard } from '../../../db/models/revisionCard.model.js';
import { RevisionAnalyticsService } from '../../../modules/revision/revisionAnalytics.service.js';
import { revisionRoutes } from '../../../modules/revision/revision.routes.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { errorHandler } from '../../../middleware/error.js';
import { entries, redis } from '../../fixtures/cacheRedis.js';

vi.mock('../../../shared/redis/client.js', async () => {
  const { redis } = await import('../../fixtures/cacheRedis.js');
  return { getRedisClient: () => redis, isRedisConfigured: () => false };
});
vi.mock('../../../middleware/auth.js', () => ({
  authMiddleware: [(req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = req.get('authorization')?.replace('Bearer ', '');
    if (!id || !Types.ObjectId.isValid(id)) return res.sendStatus(401);
    Object.assign(req, { user: { id } });
    next();
  }],
}));

const now = new Date('2026-11-18T12:00:00Z');
const day = 86_400_000;
const owner = new Types.ObjectId();
const other = new Types.ObjectId();
let cardNumber = 0;
let server: Server;
let base: string;
let middlewareCalls = 0;

beforeAll(async () => {
  await RevisionCard.init();
  const app = express();
  const routes = express.Router();
  routes.use((_req, _res, next) => { middlewareCalls++; next(); });
  routes.use('/revision', revisionRoutes);
  mountApiRoutes(app, routes);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  entries.clear();
  redis.status = 'ready';
  vi.clearAllMocks();
  middlewareCalls = 0;
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function card(overrides: Record<string, unknown> = {}) {
  return RevisionCard.create({
    userId: owner, problemKey: `leetcode:${++cardNumber}`, title: 'Test card',
    dueAt: now, createdAt: now, ...overrides,
  });
}

describe('revision analytics aggregation', () => {
  it('returns zeros and fourteen UTC buckets for an empty user', async () => {
    const data = await RevisionAnalyticsService.getAnalytics(owner.toHexString());
    expect(data).toMatchObject({ totalCards: 0, cardsDueToday: 0, retentionPercentage: 0,
      mastery: { learning: 0, reviewing: 0, mastered: 0 }, patterns: [] });
    expect(data.forecast).toHaveLength(14);
    expect(data.forecast[0]).toEqual({ date: '2026-11-18', dueCards: 0 });
    expect(data.forecast[13]).toEqual({ date: '2026-12-01', dueCards: 0 });
  });

  it('calculates retention and mastery at the strict 21-day boundary without tag duplication', async () => {
    await card({ intervalDays: 1, tags: [' Graphs ', 'Graphs', 'Trees', ''], createdAt: new Date(+now - day) });
    await card({ intervalDays: 21, repetitions: 2, tags: ['Graphs'], lastReviewedAt: new Date(+now - 21 * day) });
    await card({ intervalDays: 22, repetitions: 3, tags: ['Trees'], lastReviewedAt: now });
    await card({ userId: other, intervalDays: 100, lastReviewedAt: now });
    const data = await RevisionAnalyticsService.getAnalytics(owner.toHexString());
    expect(data.totalCards).toBe(3);
    expect(data.retentionPercentage).toBeCloseTo((200 / Math.E + 100) / 3, 8);
    expect(data.mastery).toEqual({ learning: 1, reviewing: 1, mastered: 1 });
    expect(data.patterns.map(p => [p.pattern, p.totalCards])).toEqual([['Graphs', 2], ['Trees', 2]]);
    expect(data.patterns[0].retentionPercentage).toBeCloseTo(100 / Math.E, 8);
  });

  it('uses reviewed zero-repetition resets as struggle, excluding never-reviewed cards', async () => {
    await card({ repetitions: 0, lastReviewedAt: now, tags: ['Graphs'] });
    await card({ repetitions: 0, tags: ['Graphs'] });
    await card({ repetitions: 1, lastReviewedAt: now, tags: ['Graphs'] });
    await card({ tags: [' ', ''] });
    const data = await RevisionAnalyticsService.getAnalytics(owner.toHexString());
    expect(data.patterns[0].struggleRate).toBeCloseTo(100 / 3, 8);
    expect(data.patterns[1]).toMatchObject({ pattern: 'untagged', totalCards: 1, struggleRate: 0 });
  });

  it('clamps future review times and underflows old cards to zero without invalid percentages', async () => {
    await card({ lastReviewedAt: new Date(+now + day) });
    await card({ lastReviewedAt: new Date(+now - 10000 * day) });
    const data = await RevisionAnalyticsService.getAnalytics(owner.toHexString());
    expect(data.retentionPercentage).toBe(50);
  });

  it('buckets overdue, later today, snoozed and boundary dates without forecasting repeat reviews', async () => {
    await card({ dueAt: new Date('2026-11-15T23:59:59Z') });
    await card({ dueAt: new Date('2026-11-18T23:59:59.999Z') });
    await card({ dueAt: now, snoozedUntil: new Date('2026-11-19T00:00:00Z') });
    await card({ dueAt: new Date('2026-11-19T00:00:00Z'), snoozedUntil: new Date('2026-11-17T00:00:00Z') });
    await card({ dueAt: new Date('2026-12-01T23:59:59.999Z') });
    await card({ dueAt: new Date('2026-12-02T00:00:00Z') });
    const data = await RevisionAnalyticsService.getAnalytics(owner.toHexString());
    expect(data.cardsDueToday).toBe(2);
    expect(data.forecast[0].dueCards).toBe(2);
    expect(data.forecast[1].dueCards).toBe(2);
    expect(data.forecast[13].dueCards).toBe(1);
    expect(data.forecast.reduce((sum, d) => sum + d.dueCards, 0)).toBe(5);
  });

  it('uses the userId index and measures a representative uncached query', async () => {
    await RevisionCard.insertMany(Array.from({ length: 1000 }, (_, index) => ({
      userId: owner, problemKey: `perf:${index}`, title: 'Performance fixture',
      dueAt: now, intervalDays: index % 30 + 1, repetitions: index % 4, tags: [`tag${index % 10}`],
    })));
    const aggregate = vi.spyOn(RevisionCard, 'aggregate');
    const start = performance.now();
    const data = await RevisionAnalyticsService.getAnalytics(owner.toHexString());
    const elapsed = performance.now() - start;
    console.info(`Revision analytics, 1000 cards, cold query: ${elapsed.toFixed(2)}ms`);
    expect(data.totalCards).toBe(1000);
    const pipeline = aggregate.mock.calls[0][0];
    const plan = await RevisionCard.aggregate(pipeline).explain('executionStats');
    expect(JSON.stringify(plan)).toContain('IXSCAN');
    const queryMs = plan.stages?.[0]?.$cursor?.executionStats?.executionTimeMillis;
    console.info(`Revision analytics, MongoDB execution: ${queryMs}ms`);
    const cachedStart = performance.now();
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).totalCards).toBe(1000);
    console.info(`Revision analytics, cached read: ${(performance.now() - cachedStart).toFixed(2)}ms`);
    // Record timing rather than making hardware-dependent CI assertions.
  });
});

describe('revision analytics cache', () => {
  it('caches for 600 seconds per user, refreshes on expiry, and coalesces concurrent misses', async () => {
    await card();
    const aggregate = vi.spyOn(RevisionCard, 'aggregate');
    const results = await Promise.all(Array.from({ length: 5 }, () => RevisionAnalyticsService.getAnalytics(owner.toHexString())));
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(results.every(data => data.totalCards === 1)).toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 2,
      expect.stringContaining(owner.toHexString()), expect.any(String), '0', expect.any(String), 600);
    await card();
    vi.setSystemTime(+now + 599999);
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).totalCards).toBe(1);
    expect((await RevisionAnalyticsService.getAnalytics(other.toHexString())).totalCards).toBe(0);
    vi.setSystemTime(+now + 600000);
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).totalCards).toBe(2);
    expect(aggregate).toHaveBeenCalledTimes(3);
  });

  it('refreshes forecast at UTC midnight even if the previous snapshot has not expired', async () => {
    vi.setSystemTime(new Date('2026-11-18T23:59:00Z'));
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).forecast[0].date).toBe('2026-11-18');
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).forecast[0].date).toBe('2026-11-19');
  });

  it('replaces corrupt JSON and falls back on disconnected Redis, read errors, and write errors', async () => {
    const key = `cache:revision:analytics:v1:${owner.toHexString()}:2026-11-18`;
    entries.set(key, { value: '{invalid' });
    await card();
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).totalCards).toBe(1);
    entries.clear();
    redis.status = 'end';
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).totalCards).toBe(1);
    redis.status = 'ready';
    redis.mget.mockRejectedValueOnce(new Error('offline'));
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).totalCards).toBe(1);
    redis.eval.mockRejectedValueOnce(new Error('write failed'));
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).totalCards).toBe(1);
  });

  it('does not cache database failures', async () => {
    vi.spyOn(RevisionCard, 'aggregate').mockReturnValueOnce({ exec: () => Promise.reject(new Error('database failed')) } as any);
    await expect(RevisionAnalyticsService.getAnalytics(owner.toHexString())).rejects.toThrow('database failed');
    expect(entries.size).toBe(0);
    expect((await RevisionAnalyticsService.getAnalytics(owner.toHexString())).totalCards).toBe(0);
  });
});

describe('revision analytics HTTP route', () => {
  it.each(['/api/v2', '/api/v1', '/api'])('authenticates and uses shared middleware once at %s', async prefix => {
    await card();
    await card({ userId: other });
    await card({ userId: other });
    const url = `${base}${prefix}/revision/analytics?userId=${other.toHexString()}`;
    expect((await fetch(url)).status).toBe(401);
    middlewareCalls = 0;
    const response = await fetch(url, { headers: { authorization: `Bearer ${owner.toHexString()}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.has('x-api-deprecation-warning')).toBe(prefix === '/api');
    expect((await response.json()).data.totalCards).toBe(1);
    expect(middlewareCalls).toBe(1);
  });

  it('does not expose other v1 revision endpoints under v2', async () => {
    const response = await fetch(`${base}/api/v2/revision/due`);
    expect(response.status).toBe(404);
    expect(middlewareCalls).toBe(0);
    expect(response.headers.has('x-api-deprecation-warning')).toBe(false);
  });
});
