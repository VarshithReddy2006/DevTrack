// Quota check-and-consume runs as one Lua script (issue #717).
// The fixture mirrors the script in memory; the last block runs the real script
// against a Redis server when QUOTA_TEST_REDIS_URL is set, and is skipped otherwise.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { logger } from '../../../shared/logger.js';
import { quotaEval } from '../../../__tests__/fixtures/quotaRedis.js';
import { CONSUME_QUOTA_SCRIPT, QuotaService } from '../quota.service.js';

const state = vi.hoisted(() => ({
  configured: true,
  client: undefined as unknown,
}));

vi.mock('../../../shared/redis/client.js', () => ({
  getRedisClient: () => state.client,
  isRedisConfigured: () => state.configured,
}));

const userId = 'quota-user';
// 18:00 UTC, so the key should live for the 6 hours left in the day.
const now = new Date('2026-11-27T18:00:00.000Z');
const ttlSeconds = 6 * 60 * 60;

describe('QuotaService.checkAndConsumeQuota', () => {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const fake = {
    eval: vi.fn(quotaEval(values, ttls)),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
  };
  const quota = new QuotaService({ capped: 3 });
  const key = quota.getQuotaKey(userId, 'capped', '20261127');

  beforeEach(() => {
    vi.restoreAllMocks();
    values.clear();
    ttls.clear();
    fake.eval.mockReset().mockImplementation(quotaEval(values, ttls));
    state.configured = true;
    state.client = fake;
  });

  it('checks and increments in one EVAL with the key, limit and ttl', async () => {
    const res = await quota.checkAndConsumeQuota(userId, 'capped', now);

    expect(res).toMatchObject({ allowed: true, used: 1, remaining: 2, limit: 3 });
    expect(fake.eval).toHaveBeenCalledTimes(1);
    expect(fake.eval).toHaveBeenCalledWith(CONSUME_QUOTA_SCRIPT, 1, key, 3, ttlSeconds);
  });

  it('rejects at the limit without moving the counter', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await quota.checkAndConsumeQuota(userId, 'capped', now)).allowed).toBe(true);
    }

    for (let i = 0; i < 4; i++) {
      const res = await quota.checkAndConsumeQuota(userId, 'capped', now);
      expect(res).toMatchObject({ allowed: false, used: 3, remaining: 0, limit: 3 });
    }

    expect(values.get(key)).toBe('3');
    const status = await quota.getQuotaStatus(userId, ['capped'], now);
    expect(status.capped).toMatchObject({ used: 3, remaining: 0 });
  });

  it('never lets concurrent calls go past the limit', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => quota.checkAndConsumeQuota(userId, 'capped', now)),
    );

    expect(results.filter(r => r.allowed)).toHaveLength(3);
    expect(results.filter(r => !r.allowed)).toHaveLength(17);
    expect(values.get(key)).toBe('3');
  });

  it('fails open with a warning when the script call fails', async () => {
    const warn = vi.spyOn(logger, 'warn');
    fake.eval.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await quota.checkAndConsumeQuota(userId, 'capped', now);

    expect(res).toMatchObject({ allowed: true, used: 0, remaining: 3, limit: 3 });
    expect(warn).toHaveBeenCalledWith(
      '[QuotaService] Redis quota check failed; failing open',
      { error: 'ECONNREFUSED' },
    );
  });

  it('fails open on a reply it does not understand', async () => {
    fake.eval.mockResolvedValueOnce('OK' as never);

    const res = await quota.checkAndConsumeQuota(userId, 'capped', now);

    expect(res).toMatchObject({ allowed: true, used: 0, remaining: 3 });
  });

  it('skips Redis entirely when it is not configured', async () => {
    state.configured = false;

    const res = await quota.checkAndConsumeQuota(userId, 'capped', now);

    expect(res).toMatchObject({ allowed: true, used: 1, remaining: 2 });
    expect(fake.eval).not.toHaveBeenCalled();
  });
});

const redisUrl = process.env.QUOTA_TEST_REDIS_URL;

describe.runIf(Boolean(redisUrl))('CONSUME_QUOTA_SCRIPT on a real Redis', () => {
  const clients: Redis[] = [];
  let next = 0;
  const quota = new QuotaService({ capped: 5 });
  const runId = `quota-test-${process.pid}-${Date.now()}`;
  const keyFor = (feature: string) => quota.getQuotaKey(runId, feature, '20261127');
  const admin = () => clients[0];

  beforeAll(async () => {
    // The unit setup mocks ioredis globally, so load the real client.
    const { default: RealRedis } = await vi.importActual<typeof import('ioredis')>('ioredis');
    for (let i = 0; i < 4; i++) {
      clients.push(new RealRedis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 }));
    }
    await Promise.all(clients.map(c => c.connect()));
  });

  beforeEach(async () => {
    state.configured = true;
    // Spread calls over several connections so they really reach Redis concurrently.
    state.client = new Proxy({}, {
      get: (_target, prop) => {
        const client = clients[next++ % clients.length] as unknown as Record<PropertyKey, unknown>;
        const value = client[prop];
        return typeof value === 'function' ? value.bind(client) : value;
      },
    });
    const keys = await admin().keys(`devtrack:ai:quota:${runId}:*`);
    if (keys.length) await admin().del(...keys);
  });

  afterAll(async () => {
    if (!clients.length) return;
    const keys = await admin().keys(`devtrack:ai:quota:${runId}:*`);
    if (keys.length) await admin().del(...keys);
    await Promise.all(clients.map(c => c.quit()));
  });

  it('sets a positive TTL when it creates the key', async () => {
    await quota.checkAndConsumeQuota(runId, 'capped', now);

    const ttl = await admin().ttl(keyFor('capped'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ttlSeconds);
  });

  it('keeps the counter at the limit while rejecting', async () => {
    for (let i = 0; i < 5; i++) await quota.checkAndConsumeQuota(runId, 'capped', now);

    const rejected = await quota.checkAndConsumeQuota(runId, 'capped', now);
    await quota.checkAndConsumeQuota(runId, 'capped', now);

    expect(rejected).toMatchObject({ allowed: false, used: 5, remaining: 0 });
    expect(await admin().get(keyFor('capped'))).toBe('5');
  });

  it('allows exactly `limit` calls out of a concurrent burst', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, () => quota.checkAndConsumeQuota(runId, 'capped', now)),
    );

    expect(results.filter(r => r.allowed)).toHaveLength(5);
    expect(await admin().get(keyFor('capped'))).toBe('5');
    expect(await admin().ttl(keyFor('capped'))).toBeGreaterThan(0);
  });

  it('puts the TTL back on a counter that lost it', async () => {
    await admin().set(keyFor('capped'), '2');
    expect(await admin().ttl(keyFor('capped'))).toBe(-1);

    const res = await quota.checkAndConsumeQuota(runId, 'capped', now);

    expect(res).toMatchObject({ allowed: true, used: 3 });
    expect(await admin().ttl(keyFor('capped'))).toBeGreaterThan(0);
  });

  it('also heals a counter stuck at the limit without a TTL', async () => {
    await admin().set(keyFor('capped'), '5');

    const res = await quota.checkAndConsumeQuota(runId, 'capped', now);

    expect(res.allowed).toBe(false);
    expect(await admin().get(keyFor('capped'))).toBe('5');
    expect(await admin().ttl(keyFor('capped'))).toBeGreaterThan(0);
  });
});
