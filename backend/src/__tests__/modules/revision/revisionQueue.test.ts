import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisionCard } from '../../../db/models/revisionCard.model.js';
import { RevisionQueueService } from '../../../modules/revision/revisionQueue.service.js';
import { revisionRoutes } from '../../../modules/revision/revision.routes.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { errorHandler } from '../../../middleware/error.js';

vi.mock('../../../middleware/auth.js', () => ({ authMiddleware: [
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = req.get('x-test-user');
    if (!id) return res.sendStatus(401);
    Object.assign(req, { user: { id } });
    next();
  },
] }));

const now = new Date('2026-11-18T12:00:00Z');
const day = 86_400_000;
const owner = new Types.ObjectId();
const other = new Types.ObjectId();
let sequence = 0;
let server: Server;
let origin: string;
let middlewareCalls = 0;

beforeAll(async () => {
  await RevisionCard.init();
  const app = express();
  const router = express.Router();
  router.use((_req, _res, next) => { middlewareCalls++; next(); });
  router.use('/revision', revisionRoutes);
  mountApiRoutes(app, router);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  middlewareCalls = 0;
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function card(overrides: Record<string, unknown> = {}) {
  return RevisionCard.create({ userId: owner, problemKey: `leetcode:${++sequence}`,
    title: `Question ${sequence}`, difficulty: 'medium', tags: ['graphs'], dueAt: now, createdAt: now, ...overrides });
}
const queue = (options: Parameters<typeof RevisionQueueService.getQueue>[0] = { userId: owner.toHexString(), now }) => RevisionQueueService.getQueue(options);
function get(query = '', prefix = '/api/v2', as = owner.toHexString()) {
  return fetch(`${origin}${prefix}/revision/queue${query}`, { headers: as ? { 'x-test-user': as } : {} });
}

describe('prioritized revision queue', () => {
  it('returns an empty queue for users without eligible cards', async () => {
    expect(await queue()).toEqual([]);
    await card({ userId: other });
    expect(await queue()).toEqual([]);
  });

  it('ranks by overdue days, ease and weight, with the explicit today-before-overdue-easy exception', async () => {
    const overdueEasy = await card({ title: 'Easy backlog', difficulty: 'easy', dueAt: new Date(+now - 30 * day) });
    const medium = await card({ title: 'Medium backlog', dueAt: new Date(+now - 3 * day) });
    const hard = await card({ title: 'High priority', difficulty: 'hard', dueAt: new Date(+now - day), easeFactor: 1.3, tagWeight: 2 });
    const dueToday = await card({ title: 'Due now', difficulty: 'easy' });
    const result = await queue();
    expect(result.map(c => c.id)).toEqual([hard.id, medium.id, dueToday.id, overdueEasy.id]);
    expect(result[0].priorityScore).toBeCloseTo(2.5 / 1.3 * 2, 8);
    expect(result[0].daysOverdue).toBe(1);
    expect(result[2].priorityTier).toBe('standard');
    expect(result[3]).toMatchObject({ priorityScore: 30, priorityTier: 'overdue-easy' });
    expect(result.map(card => card.estimatedReviewMinutes)).toEqual([15, 10, 5, 5]);
  });

  it('respects the exact due/snooze boundary, excludes future cards and isolates owners', async () => {
    const due = await card({ snoozedUntil: now });
    const unsnoozed = await card({ snoozedUntil: new Date(+now - 1) });
    await card({ dueAt: new Date(+now + 1) });
    await card({ dueAt: new Date(+now - day), snoozedUntil: new Date(+now + 1) });
    await card({ userId: other });
    expect((await queue()).map(c => c.id)).toEqual([due.id, unsnoozed.id]);
  });

  it('uses UTC midnight for the easy backlog tier and fractional days for scoring', async () => {
    const today = await card({ difficulty: 'easy', dueAt: new Date('2026-11-18T00:00:00Z') });
    const yesterday = await card({ difficulty: 'easy', dueAt: new Date('2026-11-17T23:59:59.999Z') });
    const result = await queue();
    expect(result.map(c => c.id)).toEqual([today.id, yesterday.id]);
    expect(result[0]).toMatchObject({ priorityTier: 'standard', daysOverdue: 0.5, priorityScore: 0.5 });
    expect(result[1].priorityTier).toBe('overdue-easy');
  });

  it('filters by exact pattern, including non-first tags, and difficulty without regex interpretation', async () => {
    await card({ difficulty: 'hard', tags: ['trees', 'dynamic-programming'] });
    await card({ difficulty: 'easy', tags: ['dynamic-programming'] });
    await card({ difficulty: 'hard', tags: ['a.*'] });
    const result = await queue({ userId: owner.toHexString(), now, pattern: ' dynamic-programming ', difficulty: 'hard' });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ difficulty: 'hard', pattern: 'dynamic-programming', tags: ['trees', 'dynamic-programming'] });
    expect(await queue({ userId: owner.toHexString(), now, pattern: '.*' })).toEqual([]);
    expect(await queue({ userId: owner.toHexString(), now, pattern: 'a.*' })).toHaveLength(1);
  });

  it('returns review-ready metadata and finite retention/time estimates without private notes', async () => {
    const saved = await card({ lastReviewedAt: new Date(+now - day), intervalDays: 1, reviewSeq: 7, notes: 'Private notes' });
    const [result] = await queue();
    expect(result).toMatchObject({ id: saved.id, title: saved.title, problemKey: saved.problemKey,
      difficulty: 'medium', pattern: 'graphs', reviewSeq: 7, estimatedReviewMinutes: 10 });
    expect(result.retentionPercentage).toBeCloseTo(100 / Math.E, 8);
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('notes');
    await RevisionCard.updateOne({ _id: saved._id }, { $set: { lastReviewedAt: new Date(+now + day) }, $unset: { tagWeight: 1 } });
    expect((await queue())[0]).toMatchObject({ tagWeight: 1, retentionPercentage: 100 });
  });

  it('defaults to 20, caps at 50, and breaks equal score/date ties by card ID', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) ids.push((await card()).id);
    const first = await queue();
    const second = await queue();
    expect(first).toHaveLength(20);
    expect(first.map(c => c.id)).toEqual(ids.sort().slice(0, 20));
    expect(first).toEqual(second);
    expect(await queue({ userId: owner.toHexString(), now, limit: '100' })).toHaveLength(50);
    expect(await queue({ userId: owner.toHexString(), now, limit: 1 })).toHaveLength(1);
  });

  it('matches a reference ordering over a larger mixed due-card dataset', async () => {
    const data = Array.from({ length: 120 }, (_, index) => ({
      _id: new Types.ObjectId(), userId: owner, title: `Fixture ${index}`, problemKey: `reference:${index}`,
      difficulty: ['easy', 'medium', 'hard'][index % 3], tags: ['arrays'],
      dueAt: new Date(+now - (index % 12) * day), easeFactor: 1.3 + index % 4,
      tagWeight: 0.5 + index % 5, intervalDays: 3, reviewSeq: index, createdAt: now,
    }));
    await RevisionCard.collection.insertMany(data);
    const expected = data.map(card => ({ ...card,
      tier: card.difficulty === 'easy' && +card.dueAt < +new Date('2026-11-18T00:00:00Z') ? 1 : 0,
      score: (+now - +card.dueAt) / day * (2.5 / card.easeFactor) * card.tagWeight,
    })).sort((a, b) => a.tier - b.tier || b.score - a.score || +a.dueAt - +b.dueAt || a._id.toHexString().localeCompare(b._id.toHexString()));
    expect((await queue({ userId: owner.toHexString(), now, limit: 50 })).map(card => card.id))
      .toEqual(expected.slice(0, 50).map(card => card._id.toHexString()));
  });

  it('benchmarks 10000 and 50000 cards and verifies the indexed aggregation plan', async () => {
    const aggregate = vi.spyOn(RevisionCard, 'aggregate');
    let inserted = 0;
    for (const total of [10000, 50000]) {
      const fixtures = Array.from({ length: total - inserted }, (_, offset) => {
        const index = inserted + offset;
        return { userId: owner, problemKey: `benchmark:${index}`, title: 'Benchmark card',
          difficulty: ['easy', 'medium', 'hard'][index % 3], tags: ['graphs'],
          dueAt: new Date(+now - (index % 30) * day), easeFactor: 1.3 + index % 4,
          tagWeight: 1, intervalDays: 7, reviewSeq: 0, createdAt: now };
      });
      await RevisionCard.collection.insertMany(fixtures);
      inserted = total;
      const start = performance.now();
      const result = await queue();
      const elapsed = performance.now() - start;
      expect(result).toHaveLength(20);
      const pipeline = aggregate.mock.calls.at(-1)![0];
      const plan = await RevisionCard.aggregate(pipeline).explain('executionStats');
      expect(JSON.stringify(plan)).toContain('IXSCAN');
      expect(JSON.stringify(plan)).toContain('userId_1_dueAt_1');
      const queryMs = plan.stages?.[0]?.$cursor?.executionStats?.executionTimeMillis;
      console.info(`Revision queue ${total} cards: service ${elapsed.toFixed(2)}ms, MongoDB ${queryMs}ms`);
      // Record real timing rather than asserting a machine-dependent latency SLA.
    }
  }, 60000);
});

describe('revision queue HTTP API', () => {
  it.each(['/api/v2', '/api/v1', '/api'])('authenticates and runs shared middleware once through %s', async prefix => {
    await card();
    await card({ userId: other });
    await card({ userId: other });
    expect((await get('', prefix, '')).status).toBe(401);
    middlewareCalls = 0;
    const response = await get(`?userId=${other.toHexString()}`, prefix);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.has('x-api-deprecation-warning')).toBe(prefix === '/api');
    const body = await response.json();
    expect(body.count).toBe(1);
    expect(body.data[0].dueAt).toBe(now.toISOString());
    expect(middlewareCalls).toBe(1);
  });

  it.each(['limit=0', 'limit=-1', 'limit=1.5', 'limit=NaN', 'limit=Infinity', 'limit=', 'limit=2x',
    'limit=9007199254740992', 'limit=1&limit=2', 'pattern=', 'pattern=x&pattern=y', 'difficulty=expert'])('rejects invalid query %s before querying cards', async query => {
    const aggregate = vi.spyOn(RevisionCard, 'aggregate');
    expect((await get(`?${query}`)).status).toBe(400);
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('applies pattern/difficulty filters and returns an empty success envelope when unmatched', async () => {
    await card({ difficulty: 'hard' });
    const response = await get('?pattern=trees&difficulty=hard&limit=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, count: 0, data: [] });
  });
});
