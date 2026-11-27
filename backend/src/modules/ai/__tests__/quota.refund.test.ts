// QuotaService.refundQuota gives back the unit LLMGateway took when no provider answered
// (issue #718). The last block runs the real script against a Redis server when
// QUOTA_TEST_REDIS_URL is set, and is skipped otherwise.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { logger } from '../../../shared/logger.js';
import { QuotaService, REFUND_QUOTA_SCRIPT } from '../quota.service.js';

const state = vi.hoisted(() => ({
  configured: true,
  client: undefined as unknown,
}));

vi.mock('../../../shared/redis/client.js', () => ({
  getRedisClient: () => state.client,
  isRedisConfigured: () => state.configured,
}));

const userId = 'refund-user';
const now = new Date('2026-11-27T18:00:00.000Z');

describe('QuotaService.refundQuota', () => {
  const values = new Map<string, string>();
  const fake = {
    // Mirrors REFUND_QUOTA_SCRIPT: decrement only a counter that is above zero.
    eval: vi.fn(async (script: string, numKeys: number, key: string) => {
      if (script !== REFUND_QUOTA_SCRIPT || numKeys !== 1) throw new Error('Unmocked Lua script in test');
      const current = Number(values.get(key) ?? '0');
      if (current <= 0) return 0;
      values.set(key, String(current - 1));
      return current - 1;
    }),
  };
  const quota = new QuotaService();
  const key = quota.getQuotaKey(userId, 'explanation', '20261127');

  beforeEach(() => {
    vi.restoreAllMocks();
    values.clear();
    fake.eval.mockClear();
    state.configured = true;
    state.client = fake;
  });

  it('decrements the counter for the day the unit was taken', async () => {
    values.set(key, '4');

    await quota.refundQuota(userId, 'explanation', now);

    expect(fake.eval).toHaveBeenCalledWith(REFUND_QUOTA_SCRIPT, 1, key);
    expect(values.get(key)).toBe('3');
  });

  it('does not go below zero or create a missing key', async () => {
    await quota.refundQuota(userId, 'explanation', now);

    expect(values.has(key)).toBe(false);
  });

  it('logs and swallows Redis errors', async () => {
    const warn = vi.spyOn(logger, 'warn');
    fake.eval.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(quota.refundQuota(userId, 'explanation', now)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[QuotaService] Redis quota refund failed', {
      userId, feature: 'explanation', error: 'ECONNRESET',
    });
  });

  it('does nothing when Redis is not configured', async () => {
    state.configured = false;

    await quota.refundQuota(userId, 'explanation', now);

    expect(fake.eval).not.toHaveBeenCalled();
  });
});

const redisUrl = process.env.QUOTA_TEST_REDIS_URL;

describe.runIf(Boolean(redisUrl))('REFUND_QUOTA_SCRIPT on a real Redis', () => {
  let client: Redis;
  const quota = new QuotaService({ capped: 5 });
  const runId = `refund-test-${process.pid}-${Date.now()}`;
  const key = quota.getQuotaKey(runId, 'capped', '20261127');

  beforeAll(async () => {
    // The unit setup mocks ioredis globally, so load the real client.
    const { default: RealRedis } = await vi.importActual<typeof import('ioredis')>('ioredis');
    client = new RealRedis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
  });

  beforeEach(async () => {
    state.configured = true;
    state.client = client;
    await client.del(key);
  });

  afterAll(async () => {
    if (!client) return;
    await client.del(key);
    await client.quit();
  });

  it('gives back a consumed unit and keeps the TTL', async () => {
    await quota.checkAndConsumeQuota(runId, 'capped', now);
    await quota.checkAndConsumeQuota(runId, 'capped', now);

    await quota.refundQuota(runId, 'capped', now);

    expect(await client.get(key)).toBe('1');
    expect(await client.ttl(key)).toBeGreaterThan(0);
  });

  it('leaves a missing key missing and a zero counter at zero', async () => {
    await quota.refundQuota(runId, 'capped', now);
    expect(await client.exists(key)).toBe(0);

    await client.set(key, '0', 'EX', 60);
    await quota.refundQuota(runId, 'capped', now);
    expect(await client.get(key)).toBe('0');
  });
});
