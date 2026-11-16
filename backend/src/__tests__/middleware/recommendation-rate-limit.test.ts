import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlidingWindowRateLimiter } from '../../middleware/rateLimitAdvanced.js';

const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ key: string; at: number }>,
  now: Date.parse('2026-11-16T00:00:00Z'),
  fail: false,
}));

vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => ({
    async eval(_script: string, _keys: number, key: string, timestamp: string, window: string, limit: string) {
      if (fixture.fail) throw new Error('Redis unavailable');
      const now = Number(timestamp);
      const current = fixture.calls.filter(call => call.key === key && call.at > now - Number(window));
      fixture.calls = current;
      if (current.length >= Number(limit)) return [0, current[0].at + Number(window) - now];
      const remaining = Number(limit) - current.length - 1;
      fixture.calls.push({ key, at: now });
      return [1, remaining];
    },
  }),
}));

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const userId = req.get('x-test-user');
    if (userId) (req as typeof req & { user: { id: string } }).user = { id: userId };
    next();
  });
  app.post('/refresh', createSlidingWindowRateLimiter(3_600_000, 5), (_req, res) => res.sendStatus(200));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.sendStatus(503));
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  fixture.calls = [];
  fixture.fail = false;
  vi.spyOn(Date, 'now').mockImplementation(() => fixture.now);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
});

function refresh(user?: string) {
  return fetch(base + '/refresh', { method: 'POST', headers: user ? { 'x-test-user': user } : {} });
}

describe('recommendation regeneration limiter', () => {
  it('allows five refreshes per user in a sliding hour, then returns 429', async () => {
    for (let i = 0; i < 5; i++) {
      const response = await refresh('ada');
      expect(response.status).toBe(200);
      expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(4 - i));
    }
    const blocked = await refresh('ada');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBe('3600');
    expect((await refresh('lin')).status).toBe(200);
    fixture.now += 3_600_001;
    expect((await refresh('ada')).status).toBe(200);
  });

  it('rejects missing identity and fails closed when Redis is unavailable', async () => {
    expect((await refresh()).status).toBe(401);
    fixture.fail = true;
    expect((await refresh('ada')).status).toBe(503);
  });
});
