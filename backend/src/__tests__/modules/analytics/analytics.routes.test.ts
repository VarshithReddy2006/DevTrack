import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnalyticsEvent } from '../../../db/models/analyticsEvent.model.js';
import { UserFeedback } from '../../../db/models/userFeedback.model.js';
import { errorHandler } from '../../../middleware/error.js';
import analyticsRoutes from '../../../modules/analytics/analytics.routes.js';

const USER_ID = '609000000000000000000001';
const VICTIM_ID = '609000000000000000000002';

vi.mock('../../../middleware/rateLimitAdvanced.js', () => ({
  rateLimiters: {
    analytics: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  },
}));

// x-test-token: user | admin sets req.user, anything else is treated as no token
vi.mock('../../../middleware/auth.js', () => {
  const users: Record<string, { id: string; role: string }> = {
    user: { id: '609000000000000000000001', role: 'user' },
    admin: { id: '609000000000000000000009', role: 'admin' },
  };
  const lookup = (req: express.Request) => users[req.get('x-test-token') ?? ''];
  return {
    optionalAuthMiddleware: [
      (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        const u = lookup(req);
        if (u) Object.assign(req, { user: u });
        next();
      },
    ],
    authMiddleware: [
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const u = lookup(req);
        if (!u) {
          res.sendStatus(401);
          return;
        }
        Object.assign(req, { user: u });
        next();
      },
    ],
    adminMiddleware: (req: express.Request & { user?: { role: string } }, res: express.Response, next: express.NextFunction) => {
      if (req.user?.role !== 'admin') {
        res.sendStatus(403);
        return;
      }
      next();
    },
  };
});

let server: Server;
let base: string;

beforeAll(async () => {
  await AnalyticsEvent.init();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/analytics', analyticsRoutes);
  app.use(errorHandler);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/analytics`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-test-token'] = token;
  return fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function get(path: string, token?: string) {
  return fetch(base + path, { headers: token ? { 'x-test-token': token } : {} });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('POST /analytics/event userId handling', () => {
  it('ignores properties.userId on an anonymous event', async () => {
    const res = await post('/event', {
      eventName: 'skill_marked_complete',
      properties: { userId: VICTIM_ID, skill: 'react' },
    });
    expect(res.status).toBe(200);

    const events = await AnalyticsEvent.find().lean();
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBeUndefined();
    expect(events[0].properties).toEqual({ skill: 'react' });
    expect(await AnalyticsEvent.countDocuments({ userId: VICTIM_ID })).toBe(0);
  });

  it('still records an anonymous event without any userId', async () => {
    const res = await post('/event', { eventName: 'resume_upload_completed' });
    expect(res.status).toBe(200);
    const [event] = await AnalyticsEvent.find().lean();
    expect(event.eventName).toBe('resume_upload_completed');
    expect(event.userId).toBeUndefined();
  });

  it('attributes an authenticated event to req.user.id, not properties.userId', async () => {
    const res = await post(
      '/event',
      { eventName: 'roadmap_generated', properties: { userId: VICTIM_ID } },
      'user'
    );
    expect(res.status).toBe(200);
    const [event] = await AnalyticsEvent.find().lean();
    expect(event.userId).toBe(USER_ID);
    // empty properties are minimized away by mongoose
    expect(event.properties ?? {}).toEqual({});
  });

  it('keeps spoofed ids out of distinct userId counts', async () => {
    await post('/event', { eventName: 'skill_marked_complete', properties: { userId: VICTIM_ID } });
    await post('/event', { eventName: 'skill_marked_complete', properties: { userId: VICTIM_ID } }, 'user');
    const ids = (await AnalyticsEvent.distinct('userId')).filter(Boolean);
    expect(ids).toEqual([USER_ID]);
  });

  it('attributes feedback only to the verified user', async () => {
    await post('/feedback', { rating: '5', page: '/home' });
    await post('/feedback', { rating: '4', page: '/home' }, 'user');
    const rows = await UserFeedback.find().sort({ rating: -1 }).lean();
    expect(rows[0].userId).toBeUndefined();
    expect(String(rows[1].userId)).toBe(USER_ID);
  });
});

describe('POST /analytics/event payload bounds', () => {
  it('rejects event names outside the allowed pattern', async () => {
    for (const eventName of ['', 'Bad Name', '$where', 'a'.repeat(101), '1abc']) {
      const res = await post('/event', { eventName });
      expect(res.status).toBe(400);
    }
    expect(await AnalyticsEvent.countDocuments()).toBe(0);
  });

  it('rejects properties over the size cap and accepts ones under it', async () => {
    const tooBig = await post('/event', {
      eventName: 'resource_clicked',
      properties: { blob: 'x'.repeat(5000) },
    });
    expect(tooBig.status).toBe(400);
    expect(await AnalyticsEvent.countDocuments()).toBe(0);

    const ok = await post('/event', {
      eventName: 'resource_clicked',
      properties: { blob: 'x'.repeat(1000) },
    });
    expect(ok.status).toBe(200);
    expect(await AnalyticsEvent.countDocuments()).toBe(1);
  });
});

describe('GET /analytics/dashboard', () => {
  async function seed() {
    await AnalyticsEvent.create([
      // inside 30 days
      { eventName: 'resume_upload_completed', userId: USER_ID, createdAt: daysAgo(1) },
      { eventName: 'resume_upload_completed', createdAt: daysAgo(2) },
      { eventName: 'roadmap_generated', userId: USER_ID, createdAt: daysAgo(3) },
      { eventName: 'roadmap_generated', userId: VICTIM_ID, createdAt: daysAgo(3) },
      { eventName: 'resource_clicked', userId: USER_ID, createdAt: daysAgo(4) },
      { eventName: 'skill_marked_complete', userId: USER_ID, createdAt: daysAgo(5) },
      { eventName: 'skill_marked_complete', userId: USER_ID, createdAt: daysAgo(6) },
      { eventName: 'skill_marked_complete', createdAt: daysAgo(6) },
      { eventName: 'career_discovery_completed', userId: USER_ID, createdAt: daysAgo(7) },
      // outside 30 days, inside 90
      { eventName: 'roadmap_generated', userId: VICTIM_ID, createdAt: daysAgo(60) },
      { eventName: 'skill_marked_complete', userId: VICTIM_ID, createdAt: daysAgo(60) },
      // not a funnel event
      { eventName: 'something_else', userId: USER_ID, createdAt: daysAgo(1) },
    ]);
  }

  it('requires an admin', async () => {
    expect((await get('/dashboard')).status).toBe(401);
    expect((await get('/dashboard', 'user')).status).toBe(403);
  });

  it('defaults to a 30 day window and reports accurate counts', async () => {
    await seed();
    const res = await get('/dashboard', 'admin');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.window.days).toBe(30);
    expect(data.funnel).toEqual({
      resumesUploaded: 2,
      discoveryCompleted: 1,
      roadmapsGenerated: 2,
      resourceClicks: 1,
      skillsCompleted: 3,
    });
    // one unique signed-in completer in the window, anonymous event not counted
    expect(data.metrics.completionRate).toBe((1 / 2) * 100);
    expect(data.metrics.activationRate).toBe((2 / 2) * 100);
    expect(data.metrics.learningEngagement).toBe((1 / 2) * 100);
  });

  it('widens and narrows with the days param', async () => {
    await seed();
    const wide = (await (await get('/dashboard?days=90', 'admin')).json()).data;
    expect(wide.funnel.roadmapsGenerated).toBe(3);
    expect(wide.funnel.skillsCompleted).toBe(4);
    expect(wide.metrics.completionRate).toBe((2 / 3) * 100);

    const narrow = (await (await get('/dashboard?days=2', 'admin')).json()).data;
    expect(narrow.funnel.resumesUploaded).toBe(1);
    expect(narrow.funnel.roadmapsGenerated).toBe(0);
    expect(narrow.metrics.completionRate).toBe(0);
  });

  it('rejects out of range days', async () => {
    for (const days of ['0', '-1', '91', '9999', 'abc', '1.5']) {
      expect((await get(`/dashboard?days=${days}`, 'admin')).status).toBe(400);
    }
  });

  it('returns zeros on an empty collection', async () => {
    const { data } = await (await get('/dashboard', 'admin')).json();
    expect(data.funnel.roadmapsGenerated).toBe(0);
    expect(data.metrics.completionRate).toBe(0);
  });

  it('runs one windowed aggregation instead of unbounded counts', async () => {
    await seed();
    const aggregate = vi.spyOn(AnalyticsEvent, 'aggregate');
    const countDocuments = vi.spyOn(AnalyticsEvent, 'countDocuments');
    const distinct = vi.spyOn(AnalyticsEvent, 'distinct');

    const res = await get('/dashboard?days=7', 'admin');
    expect(res.status).toBe(200);

    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(countDocuments).not.toHaveBeenCalled();
    expect(distinct).not.toHaveBeenCalled();
    const pipeline = aggregate.mock.calls[0][0] as any[];
    const match = pipeline[0].$match;
    expect(match.createdAt.$gte).toBeInstanceOf(Date);
    const ageDays = (Date.now() - match.createdAt.$gte.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(6.99);
    expect(ageDays).toBeLessThan(7.01);
    expect(pipeline.some(stage => '$facet' in stage)).toBe(true);
  });
});

describe('AnalyticsEvent indexes', () => {
  it('has the eventName + createdAt compound index', () => {
    const keys = AnalyticsEvent.schema.indexes().map(([spec]) => JSON.stringify(spec));
    expect(keys).toContain(JSON.stringify({ eventName: 1, createdAt: -1 }));
  });
});
