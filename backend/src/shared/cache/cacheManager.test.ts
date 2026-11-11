import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cacheManager, CACHE_KEYS } from './cacheManager.js';
import { deferred, entries, redis } from '../../__tests__/fixtures/cacheRedis.js';
import { getMetricsSnapshot } from '../requestMetrics.js';

vi.mock('../redis/client.js', async () => {
  const { redis } = await import('../../__tests__/fixtures/cacheRedis.js');
  return { getRedisClient: () => redis };
});
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

beforeEach(() => {
  entries.clear(); redis.status = 'ready';
  redis.mget.mockReset(); redis.eval.mockReset();
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const key = CACHE_KEYS.dashboard('owner');

it('coalesces ten simultaneous cold and expired reads into one load per batch', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const load = vi.fn(async () => ({ total: 1 }));
  for (let batch = 1; batch <= 2; batch++) {
    const results = await Promise.all(Array.from({ length: 10 }, () => cacheManager.getOrSet(key, load)));
    expect(results).toEqual(Array(10).fill({ total: 1 }));
    expect(load).toHaveBeenCalledTimes(batch);
    await cacheManager.getOrSet(key, load);
    expect(load).toHaveBeenCalledTimes(batch);
    vi.setSystemTime(Date.now() + 300_001);
  }
  expect(cacheManager.getReadStats().inFlight).toBe(0);
});

it('keeps users isolated and reloads only the invalidated dashboard', async () => {
  const otherKey = CACHE_KEYS.dashboard('other');
  const load = vi.fn(async () => 'owner');
  const otherLoad = vi.fn(async () => 'other');
  await cacheManager.getOrSet(key, load);
  await cacheManager.getOrSet(otherKey, otherLoad);
  await cacheManager.invalidateDashboard('owner');
  expect(await cacheManager.getOrSet(key, load)).toBe('owner');
  expect(await cacheManager.getOrSet(otherKey, otherLoad)).toBe('other');
  expect(load).toHaveBeenCalledTimes(2);
  expect(otherLoad).toHaveBeenCalledTimes(1);
});

it('detaches an invalidated load without letting its cleanup remove a newer load', async () => {
  const old = deferred<string>();
  const fresh = deferred<string>();
  const started = deferred<void>();
  const oldRead = cacheManager.getOrSet(key, () => { started.resolve(); return old.promise; });
  await started.promise;
  await cacheManager.invalidateDashboard('owner');
  const freshStarted = deferred<void>();
  const freshLoad = vi.fn(() => { freshStarted.resolve(); return fresh.promise; });
  const freshRead = cacheManager.getOrSet(key, freshLoad);
  await freshStarted.promise;
  old.resolve('old');
  expect(await oldRead).toBe('old');
  const joined = cacheManager.getOrSet(key, freshLoad);
  fresh.resolve('fresh');
  expect(await freshRead).toBe('fresh');
  expect(await joined).toBe('fresh');
  expect(freshLoad).toHaveBeenCalledTimes(1);
  expect(await cacheManager.getOrSet(key, async () => 'wrong')).toBe('fresh');
});

it('rejects a stale cache fill when another process advances the Redis generation', async () => {
  const old = deferred<string>();
  const started = deferred<void>();
  const read = cacheManager.getOrSet(key, () => { started.resolve(); return old.promise; });
  await started.promise;
  // Simulate a worker invalidation without touching this API's in-flight map.
  entries.set(`${key}:generation`, { value: '1' });
  entries.delete(key);
  old.resolve('stale');
  await read;
  expect(entries.has(key)).toBe(false);
  expect(await cacheManager.getOrSet(key, async () => 'fresh')).toBe('fresh');
});

it('releases failed loaders and allows a subsequent retry', async () => {
  const fail = vi.fn(async () => { throw new Error('database unavailable'); });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => cacheManager.getOrSet(key, fail)));
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  expect(fail).toHaveBeenCalledTimes(1);
  expect(cacheManager.getReadStats().inFlight).toBe(0);
  expect(await cacheManager.getOrSet(key, async () => 'recovered')).toBe('recovered');
});

it('treats malformed cache JSON as a miss', async () => {
  entries.set(key, { value: '{broken' });
  expect(await cacheManager.getOrSet(key, async () => ({ value: 3 }))).toEqual({ value: 3 });
  expect(JSON.parse(entries.get(key)!.value)).toEqual({ value: 3 });
});

it.each(['offline', 'read-error', 'fill-error'] as const)('returns database results during %s', async failure => {
  if (failure === 'offline') redis.status = 'end';
  if (failure === 'read-error') redis.mget.mockRejectedValue(new Error('Redis read failed'));
  if (failure === 'fill-error') redis.eval.mockRejectedValue(new Error('Redis fill failed'));
  const load = vi.fn(async () => ({ value: 3 }));
  expect(await Promise.all(Array.from({ length: 10 }, () => cacheManager.getOrSet(key, load))))
    .toEqual(Array(10).fill({ value: 3 }));
  expect(load).toHaveBeenCalledTimes(1);
  expect(cacheManager.getReadStats().inFlight).toBe(0);
});

it('does not reject committed writes when invalidation fails', async () => {
  redis.eval.mockRejectedValueOnce(new Error('Redis offline'));
  await expect(cacheManager.invalidateAllUserCache('owner')).resolves.toBeUndefined();
});

it('bounds stalled Redis reads and still coalesces the database fallback', async () => {
  vi.useFakeTimers();
  redis.mget.mockImplementation(() => new Promise(() => {}));
  const fallback = deferred<string>();
  const load = vi.fn(() => fallback.promise);
  const reads = Array.from({ length: 10 }, () => cacheManager.getOrSet(key, load));
  await vi.advanceTimersByTimeAsync(500);
  fallback.resolve('fresh');
  expect(await Promise.all(reads)).toEqual(Array(10).fill('fresh'));
  expect(load).toHaveBeenCalledTimes(1);
});

it('reports cache counters in the existing request metrics snapshot', async () => {
  const before = getMetricsSnapshot().cache;
  await cacheManager.getOrSet(key, async () => 'data');
  await cacheManager.getOrSet(key, async () => 'wrong');
  const after = getMetricsSnapshot().cache;
  expect(after.hits - before.hits).toBe(1);
  expect(after.misses - before.misses).toBe(1);
  expect(after.loads - before.loads).toBe(1);
  expect(after.inFlight).toBe(0);
});
