import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Tiny in-memory Redis stand-in for rateLimitAdvanced (no sockets, no real service).
const redis = vi.hoisted(() => ({ counts: new Map<string, number>() }));
vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => ({
    get: async (k: string) => (redis.counts.has(k) ? String(redis.counts.get(k)) : null),
    ttl: async () => 30,
    incr: async (k: string) => {
      redis.counts.set(k, (redis.counts.get(k) ?? 0) + 1);
      return redis.counts.get(k)!;
    },
    pexpire: async () => 1,
    set: async () => 'OK',
  }),
}));
// The real logger pulls in the tracing stack, which is irrelevant here.
vi.mock('../../shared/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

import { configureTrustProxy, parseTrustProxy } from '../../config/trustProxy.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { rateLimiters } from '../../middleware/rateLimitAdvanced.js';

describe('parseTrustProxy', () => {
  it.each([undefined, '', '   ', '0'])('treats %j as "no proxy"', (raw) => {
    expect(parseTrustProxy(raw)).toBeUndefined();
  });

  it.each([['1', 1], ['2', 2], [' 3 ', 3]])('parses %j as %i hops', (raw, hops) => {
    expect(parseTrustProxy(raw)).toBe(hops);
  });

  it.each(['true', 'false', 'yes', '-1', '1.5', '1e2', '0x1', 'loopback', '1,2', '99999999999999999999', '33'])(
    'rejects %j instead of silently trusting everything',
    (raw) => {
      expect(() => parseTrustProxy(raw)).toThrow(/TRUST_PROXY/);
    },
  );
});

describe('trust proxy and IP-keyed rate limiting', () => {
  const clients = ['203.0.113.1', '203.0.113.2', '203.0.113.3'];
  let server: Server | undefined;

  beforeEach(() => redis.counts.clear());
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  // Same shape as the real API: limiter first, handler after. Fresh limiter per
  // test because rateLimit() keeps its counters in one module-level map.
  async function listen(hops: number | undefined, maxRequests: number): Promise<string> {
    const app = express();
    configureTrustProxy(app, hops);
    app.use(rateLimit({ windowMs: 60_000, maxRequests }));
    app.get('/ping', (_req, res) => void res.json({ ok: true }));
    app.get('/sse', rateLimiters.sse, (_req, res) => void res.json({ ok: true }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const get = (base: string, path: string, ip: string) =>
    fetch(base + path, { headers: { 'X-Forwarded-For': ip } }).then((r) => r.status);

  it('counts each X-Forwarded-For client separately when TRUST_PROXY=1', async () => {
    const base = await listen(1, 2);
    // Same real clients that nginx / Render would forward. Each sends one request.
    const statuses = [];
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) statuses.push(await get(base, '/ping', ip));
    expect(statuses).toEqual([200, 200, 200]);
  });

  it('still limits a single client behind the proxy', async () => {
    const base = await listen(1, 2);
    const ip = '198.51.100.9';
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push(await get(base, '/ping', ip));
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('shares one bucket when TRUST_PROXY is unset (the default)', async () => {
    const base = await listen(undefined, 2);
    const statuses = [];
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) statuses.push(await get(base, '/ping', ip));
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('keys the Redis-backed limiters by client IP when TRUST_PROXY=1', async () => {
    const base = await listen(1, 100);
    for (const ip of clients) await get(base, '/sse', ip);
    const keys = [...redis.counts.keys()];
    expect(keys).toHaveLength(clients.length);
    for (const ip of clients) expect(keys.some((k) => k.includes(ip))).toBe(true);
  });

  it('keys the Redis-backed limiters by the socket address when TRUST_PROXY is unset', async () => {
    const base = await listen(undefined, 100);
    for (const ip of clients) await get(base, '/sse', ip);
    const keys = [...redis.counts.keys()];
    expect(new Set(keys).size).toBe(1);
    for (const ip of clients) expect(keys.some((k) => k.includes(ip))).toBe(false);
  });
});
