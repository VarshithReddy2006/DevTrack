// src/__tests__/shared/redis/distributedLock.test.ts
// Unit and integration tests for distributed locking and ownership fencing.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type Redis from 'ioredis';
import {
  DistributedLock,
  DistributedLockUnavailableError,
  acquireDistributedLock,
  acquireWithRetry,
  releaseDistributedLock,
  extendDistributedLock,
  withDistributedLock,
  withDistributedLockRetry,
  clearTestFallbackLocks,
  formatJobLockKey,
  formatFenceKey,
  ACQUIRE_WITH_FENCE_LUA_SCRIPT,
  RELEASE_LOCK_LUA_SCRIPT,
  EXTEND_LOCK_LUA_SCRIPT,
  DEFAULT_LOCK_PREFIX,
  DEFAULT_FENCE_PREFIX,
} from '../../../shared/redis/distributedLock.js';

interface RedisEntry {
  value: string;
  expiresAt: number;
}

describe('DistributedLock & withDistributedLock', () => {
  let memoryStore: Map<string, RedisEntry>;
  let mockRedis: Partial<Redis>;
  let currentTime: number;

  beforeEach(() => {
    vi.useFakeTimers();
    currentTime = 1_000_000;
    vi.setSystemTime(currentTime);

    memoryStore = new Map<string, RedisEntry>();

    function getLiveEntry(key: string): RedisEntry | null {
      const entry = memoryStore.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= currentTime) {
        memoryStore.delete(key);
        return null;
      }
      return entry;
    }

    const fenceCounters = new Map<string, number>();

    mockRedis = {
      status: 'ready',
      set: vi.fn(async (key: string, value: string, pxFlag?: string, ttlMs?: number, nxFlag?: string) => {
        if (nxFlag === 'NX') {
          const existing = getLiveEntry(key);
          if (existing) {
            return null; // Key already held
          }
        }
        const expiresAt =
          pxFlag === 'PX' && typeof ttlMs === 'number' ? currentTime + ttlMs : Infinity;
        memoryStore.set(key, { value, expiresAt });
        return 'OK';
      }),

      eval: vi.fn(async (script: string, numKeys: number, ...args: Array<string | number>) => {
        if (script === ACQUIRE_WITH_FENCE_LUA_SCRIPT && numKeys === 2) {
          const lockKey = String(args[0]);
          const fenceKey = String(args[1]);
          const ownerToken = String(args[2]);
          const ttlMs = Number(args[3]);
          const res = await (mockRedis.set as Function)(lockKey, ownerToken, 'PX', ttlMs, 'NX');
          if (res !== 'OK') {
            return 0;
          }
          const next = (fenceCounters.get(fenceKey) ?? 0) + 1;
          fenceCounters.set(fenceKey, next);
          return next;
        }

        const key = String(args[0]);
        const entry = getLiveEntry(key);

        if (script === RELEASE_LOCK_LUA_SCRIPT) {
          const ownerToken = String(args[1]);
          if (entry && entry.value === ownerToken) {
            memoryStore.delete(key);
            return 1;
          }
          return 0;
        }

        if (script === EXTEND_LOCK_LUA_SCRIPT) {
          const ownerToken = String(args[1]);
          const newTtlMs = Number(args[2]);
          if (entry && entry.value === ownerToken) {
            entry.expiresAt = currentTime + newTtlMs;
            return 1;
          }
          return 0;
        }

        throw new Error(`Unmocked Lua script in test: ${script}`);
      }),
    } as unknown as Redis;
  });

  afterEach(() => {
    clearTestFallbackLocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe('Key Formatting', () => {
    it('prefixes standard job names with default lock prefix', () => {
      expect(formatJobLockKey('quest_generation')).toBe(`${DEFAULT_LOCK_PREFIX}quest_generation`);
      expect(formatJobLockKey('streak_at_risk')).toBe(`${DEFAULT_LOCK_PREFIX}streak_at_risk`);
    });

    it('preserves existing namespaced keys unchanged', () => {
      expect(formatJobLockKey('devtrack:lock:job:custom')).toBe('devtrack:lock:job:custom');
      expect(formatJobLockKey('sse:sync:scheduler:leader')).toBe('sse:sync:scheduler:leader');
      expect(formatJobLockKey('missions:scheduler:daily:2026-11-24')).toBe(
        'missions:scheduler:daily:2026-11-24'
      );
    });
  });

  describe('Lock Acquisition & Exclusivity', () => {
    it('successfully acquires a lock when key is free', async () => {
      const lock = new DistributedLock('test_job', {
        redisClient: mockRedis as Redis,
        ttlMs: 30_000,
      });

      expect(lock.isHeld).toBe(false);
      const acquired = await lock.acquire();

      expect(acquired).toBe(true);
      expect(lock.isHeld).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `${DEFAULT_LOCK_PREFIX}test_job`,
        lock.ownerToken,
        'PX',
        30_000,
        'NX'
      );
    });

    it('prevents multiple instances from acquiring the same lock concurrently', async () => {
      const instance1 = new DistributedLock('sync_sweep', { redisClient: mockRedis as Redis });
      const instance2 = new DistributedLock('sync_sweep', { redisClient: mockRedis as Redis });

      const acquired1 = await instance1.acquire();
      const acquired2 = await instance2.acquire();

      expect(acquired1).toBe(true);
      expect(acquired2).toBe(false);
      expect(instance1.isHeld).toBe(true);
      expect(instance2.isHeld).toBe(false);
    });

    it('generates distinct owner tokens for each lock instance', () => {
      const lock1 = new DistributedLock('job_a');
      const lock2 = new DistributedLock('job_a');

      expect(lock1.ownerToken).not.toBe(lock2.ownerToken);
      expect(lock1.ownerToken.length).toBeGreaterThan(10);
    });
  });

  describe('Safe Lock Release & Ownership Fencing', () => {
    it('allows the lock owner to safely release the lock', async () => {
      const lock = new DistributedLock('job_a', { redisClient: mockRedis as Redis });
      await lock.acquire();

      const released = await lock.release();
      expect(released).toBe(true);
      expect(lock.isHeld).toBe(false);

      // Subsequent acquisition should now succeed
      const lock2 = new DistributedLock('job_a', { redisClient: mockRedis as Redis });
      const acquiredAgain = await lock2.acquire();
      expect(acquiredAgain).toBe(true);
    });

    it('prevents a non-owner or stale worker from releasing another worker lock', async () => {
      const worker1 = new DistributedLock('exclusive_sweep', {
        redisClient: mockRedis as Redis,
        ttlMs: 5_000,
      });
      await worker1.acquire();

      // Simulate worker1 stalling and lock expiring in Redis
      currentTime += 6_000;
      vi.setSystemTime(currentTime);

      // Worker2 now acquires the expired lock
      const worker2 = new DistributedLock('exclusive_sweep', {
        redisClient: mockRedis as Redis,
        ttlMs: 10_000,
      });
      const acquired2 = await worker2.acquire();
      expect(acquired2).toBe(true);

      // Worker1 now wakes up and attempts to release the lock
      const releasedByWorker1 = await worker1.release();

      // Worker1 must return false and NOT delete worker2's lock
      expect(releasedByWorker1).toBe(false);
      expect(worker2.isHeld).toBe(true);

      // Worker2 should still be able to release its own lock safely
      const releasedByWorker2 = await worker2.release();
      expect(releasedByWorker2).toBe(true);
    });
  });

  describe('Lock Expiration (TTL)', () => {
    it('allows re-acquisition after lock TTL expires naturally', async () => {
      const lock1 = new DistributedLock('temp_job', {
        redisClient: mockRedis as Redis,
        ttlMs: 10_000,
      });
      await lock1.acquire();

      // Advance time beyond TTL
      currentTime += 10_001;
      vi.setSystemTime(currentTime);

      const lock2 = new DistributedLock('temp_job', {
        redisClient: mockRedis as Redis,
        ttlMs: 10_000,
      });
      const acquired = await lock2.acquire();
      expect(acquired).toBe(true);
    });
  });

  describe('Lease Extension & Heartbeat', () => {
    it('extends the lock TTL atomically when called by the owner', async () => {
      const lock = new DistributedLock('long_job', {
        redisClient: mockRedis as Redis,
        ttlMs: 10_000,
      });
      await lock.acquire();

      // Advance time by 8 seconds (2s left)
      currentTime += 8_000;
      vi.setSystemTime(currentTime);

      // Owner extends TTL by 10s
      const extended = await lock.extend(10_000);
      expect(extended).toBe(true);

      // Advance by another 5 seconds (13s total from start, original would have expired at 10s)
      currentTime += 5_000;
      vi.setSystemTime(currentTime);

      // A competitor should still be blocked
      const competitor = new DistributedLock('long_job', { redisClient: mockRedis as Redis });
      expect(await competitor.acquire()).toBe(false);
    });

    it('auto-renews lock via heartbeat until released', async () => {
      const lock = new DistributedLock('heartbeat_job', {
        redisClient: mockRedis as Redis,
        ttlMs: 6_000,
      });
      await lock.acquire();
      lock.startAutoRenew(2_000); // Heartbeat every 2s

      // Advance time 5 seconds with timer ticks
      await vi.advanceTimersByTimeAsync(5_000);
      currentTime += 5_000;

      // Lock should still be held because heartbeat kept renewing it
      const competitor = new DistributedLock('heartbeat_job', { redisClient: mockRedis as Redis });
      expect(await competitor.acquire()).toBe(false);

      // Release lock and verify heartbeat stops
      await lock.release();
      const acquiredAfterRelease = await competitor.acquire();
      expect(acquiredAfterRelease).toBe(true);
    });
  });

  describe('withDistributedLock Higher-Level Wrapper', () => {
    it('executes task and returns result when lock is acquired', async () => {
      let taskExecuted = false;

      const result = await withDistributedLock(
        'task_exec',
        async (lock) => {
          expect(lock.isHeld).toBe(true);
          taskExecuted = true;
          return { count: 42 };
        },
        { redisClient: mockRedis as Redis, ttlMs: 10_000 }
      );

      expect(taskExecuted).toBe(true);
      expect(result).toEqual({ executed: true, result: { count: 42 } });

      // Lock should be released automatically in finally block
      const nextLock = new DistributedLock('task_exec', { redisClient: mockRedis as Redis });
      expect(await nextLock.acquire()).toBe(true);
    });

    it('skips task execution when lock is already held', async () => {
      const heldLock = new DistributedLock('running_job', { redisClient: mockRedis as Redis });
      await heldLock.acquire();

      let taskExecuted = false;
      const result = await withDistributedLock(
        'running_job',
        async () => {
          taskExecuted = true;
          return 'done';
        },
        { redisClient: mockRedis as Redis }
      );

      expect(taskExecuted).toBe(false);
      expect(result).toEqual({ executed: false, reason: 'lock_held' });
    });

    it('releases lock even if task throws an error (prevents permanent orphaned locks)', async () => {
      let errorThrown = false;

      try {
        await withDistributedLock(
          'failing_job',
          async () => {
            throw new Error('Task crashed!');
          },
          { redisClient: mockRedis as Redis }
        );
      } catch (err) {
        errorThrown = true;
        expect((err as Error).message).toBe('Task crashed!');
      }

      expect(errorThrown).toBe(true);

      // Verify that despite failure, the lock was safely released
      const nextWorker = new DistributedLock('failing_job', { redisClient: mockRedis as Redis });
      const acquired = await nextWorker.acquire();
      expect(acquired).toBe(true);
    });
  });

  describe('Graceful Redis Failure Handling', () => {
    it('handles Redis connection errors gracefully during acquire', async () => {
      const failingRedis = {
        status: 'ready',
        set: vi.fn().mockRejectedValue(new Error('Redis connection refused')),
      } as unknown as Redis;

      const lock = new DistributedLock('err_job', {
        redisClient: failingRedis,
        fallbackOnRedisUnavailable: false,
      });
      const acquired = await lock.acquire();

      expect(acquired).toBe(false);
      expect(lock.isHeld).toBe(false);
    });

    it('handles Redis errors gracefully during release', async () => {
      const failingRedis = {
        status: 'ready',
        set: vi.fn().mockResolvedValue('OK'),
        eval: vi.fn().mockRejectedValue(new Error('Redis timeout on release')),
      } as unknown as Redis;

      const lock = new DistributedLock('err_release_job', { redisClient: failingRedis });
      await lock.acquire();

      const released = await lock.release();
      expect(released).toBe(false);
      expect(lock.isHeld).toBe(false);
    });

    it('uses fallback lock handle when Redis status is not ready in test/fallback mode', async () => {
      const offlineRedis = {
        status: 'close',
      } as unknown as Redis;

      const lock = await acquireDistributedLock('offline_job', {
        redisClient: offlineRedis,
        fallbackOnRedisUnavailable: true,
      });

      expect(lock).not.toBeNull();
      expect(lock?.isHeld).toBe(true);

      const released = await releaseDistributedLock(lock!);
      expect(released).toBe(true);
      expect(lock?.isHeld).toBe(false);
    });
  });

  describe('Fail-Closed Semantics & Redis Outage Safety (#616)', () => {
    it('throws DistributedLockUnavailableError when Redis is disconnected even if fallbackOnRedisUnavailable is omitted in test env', async () => {
      const offlineRedis = {
        status: 'close',
      } as unknown as Redis;

      await expect(
        acquireDistributedLock('fail_closed_default', { redisClient: offlineRedis })
      ).rejects.toThrow(DistributedLockUnavailableError);

      try {
        await acquireDistributedLock('fail_closed_default', { redisClient: offlineRedis });
      } catch (err) {
        expect(err).toBeInstanceOf(DistributedLockUnavailableError);
        const lockErr = err as DistributedLockUnavailableError;
        expect(lockErr.lockKey).toBe(`${DEFAULT_LOCK_PREFIX}fail_closed_default`);
        expect(lockErr.reason).toBe('redis_not_ready');
      }
    });

    it('strictly ignores fallbackOnRedisUnavailable: true outside NODE_ENV=test and fails closed in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const offlineRedis = {
        status: 'reconnecting',
      } as unknown as Redis;

      await expect(
        acquireDistributedLock('prod_critical_sweep', {
          redisClient: offlineRedis,
          fallbackOnRedisUnavailable: true,
        })
      ).rejects.toThrow(DistributedLockUnavailableError);

      let taskRan = false;
      const result = await withDistributedLock(
        'prod_critical_sweep',
        async () => {
          taskRan = true;
          return 'unsafe';
        },
        {
          redisClient: offlineRedis,
          fallbackOnRedisUnavailable: true,
        }
      );

      expect(taskRan).toBe(false);
      expect(result).toEqual({ executed: false, reason: 'redis_unavailable' });
    });

    it('never grants pre-held ownership when constructing DistributedLock in fallbackMode outside test env or before acquire()', async () => {
      const offlineRedis = { status: 'close' } as unknown as Redis;

      // In test env, fallbackMode lock must not report isHeld before acquire()
      const testLock = new DistributedLock('preheld_check', { redisClient: offlineRedis }, true);
      expect(testLock.isHeld).toBe(false);

      // Outside test env, fallbackMode constructor flag must be ignored completely
      vi.stubEnv('NODE_ENV', 'production');
      const prodLock = new DistributedLock('prod_preheld_check', { redisClient: offlineRedis }, true);
      expect(prodLock.isHeld).toBe(false);
      expect(await prodLock.acquire()).toBe(false);
      expect(prodLock.isHeld).toBe(false);
    });

    it('prevents two concurrent callers from entering critical section during Redis outage', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const offlineRedis = { status: 'close' } as unknown as Redis;
      let executions = 0;

      const [res1, res2] = await Promise.all([
        withDistributedLock(
          'concurrent_outage_job',
          async () => {
            executions++;
            return 'worker-1';
          },
          { redisClient: offlineRedis, fallbackOnRedisUnavailable: true }
        ),
        withDistributedLock(
          'concurrent_outage_job',
          async () => {
            executions++;
            return 'worker-2';
          },
          { redisClient: offlineRedis, fallbackOnRedisUnavailable: true }
        ),
      ]);

      expect(executions).toBe(0);
      expect(res1).toEqual({ executed: false, reason: 'redis_unavailable' });
      expect(res2).toEqual({ executed: false, reason: 'redis_unavailable' });
    });

    it('enforces single-owner exclusion even in test-only in-memory fallback mode', async () => {
      const offlineRedis = { status: 'close' } as unknown as Redis;
      let activeConcurrent = 0;
      let maxConcurrent = 0;
      let releaseFirst!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let finishFirst!: () => void;
      const holdFirst = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });

      const firstPromise = withDistributedLock(
        'test_in_memory_mutex',
        async (lock) => {
          expect(lock.isHeld).toBe(true);
          activeConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, activeConcurrent);
          releaseFirst();
          await holdFirst;
          activeConcurrent--;
          return 'first';
        },
        { redisClient: offlineRedis, fallbackOnRedisUnavailable: true }
      );

      await firstStarted;

      let secondExecuted = false;
      const secondResult = await withDistributedLock(
        'test_in_memory_mutex',
        async () => {
          secondExecuted = true;
          return 'second';
        },
        { redisClient: offlineRedis, fallbackOnRedisUnavailable: true }
      );

      expect(secondExecuted).toBe(false);
      expect(secondResult).toEqual({ executed: false, reason: 'lock_held' });
      expect(maxConcurrent).toBe(1);

      finishFirst();
      const firstResult = await firstPromise;
      expect(firstResult).toEqual({ executed: true, result: 'first' });

      // After release, a new test-mode caller can acquire cleanly
      const thirdResult = await withDistributedLock(
        'test_in_memory_mutex',
        async () => 'third',
        { redisClient: offlineRedis, fallbackOnRedisUnavailable: true }
      );
      expect(thirdResult).toEqual({ executed: true, result: 'third' });
    });

    it('throws DistributedLockUnavailableError with reason redis_error when Redis SET fails with command error', async () => {
      const failingSetRedis = {
        status: 'ready',
        set: vi.fn().mockRejectedValue(new Error('ETIMEDOUT: socket hang up')),
      } as unknown as Redis;

      await expect(
        acquireDistributedLock('set_err_job', { redisClient: failingSetRedis })
      ).rejects.toThrow(DistributedLockUnavailableError);

      let executed = false;
      const result = await withDistributedLock(
        'set_err_job',
        async () => {
          executed = true;
          return 'bad';
        },
        { redisClient: failingSetRedis }
      );

      expect(executed).toBe(false);
      expect(result).toEqual({ executed: false, reason: 'redis_error' });
    });

    it('keeps isHeld false and returns false on release after failed acquisition or disconnection', async () => {
      const offlineRedis = {
        status: 'close',
        eval: vi.fn(),
      } as unknown as Redis;

      const failedLock = new DistributedLock('never_acquired', { redisClient: offlineRedis });
      expect(await failedLock.acquire()).toBe(false);
      expect(failedLock.isHeld).toBe(false);
      expect(await failedLock.release()).toBe(false);
      expect(failedLock.isHeld).toBe(false);
      expect(offlineRedis.eval).not.toHaveBeenCalled();

      // Acquire while healthy, then lose Redis before extend/release
      let currentStatus = 'ready';
      const flakyRedis = {
        get status() {
          return currentStatus;
        },
        set: vi.fn().mockResolvedValue('OK'),
        eval: vi.fn().mockResolvedValue(1),
      } as unknown as Redis;

      const lock = new DistributedLock('drop_mid_flight', { redisClient: flakyRedis });
      expect(await lock.acquire()).toBe(true);
      expect(lock.isHeld).toBe(true);

      // Redis disconnects mid-flight
      currentStatus = 'close';
      expect(await lock.extend(10_000)).toBe(false);
      expect(lock.isHeld).toBe(false);
      expect(await lock.release()).toBe(false);
      expect(lock.isHeld).toBe(false);
    });

    it('recovers cleanly once Redis becomes available again after an outage', async () => {
      let redisOnline = false;
      const recoveringRedis = {
        get status() {
          return redisOnline ? 'ready' : 'reconnecting';
        },
        set: vi.fn(async (key: string, val: string, px?: string, ttl?: number, nx?: string) =>
          (mockRedis.set as Function)(key, val, px, ttl, nx)
        ),
        eval: vi.fn(async (script: string, numKeys: number, ...args: Array<string | number>) =>
          (mockRedis.eval as Function)(script, numKeys, ...args)
        ),
      } as unknown as Redis;

      let outageRan = false;
      const duringOutage = await withDistributedLock(
        'recovery_job',
        async () => {
          outageRan = true;
          return 'during-outage';
        },
        { redisClient: recoveringRedis }
      );
      expect(outageRan).toBe(false);
      expect(duringOutage).toEqual({ executed: false, reason: 'redis_unavailable' });

      // Redis recovers
      redisOnline = true;
      const afterRecovery = await withDistributedLock(
        'recovery_job',
        async (lock) => {
          expect(lock.isHeld).toBe(true);
          return 'recovered';
        },
        { redisClient: recoveringRedis }
      );
      expect(afterRecovery).toEqual({ executed: true, result: 'recovered' });
    });

    it('propagates task exception cleanly when Redis drops before finally release', async () => {
      let status = 'ready';
      const dropOnReleaseRedis = {
        get status() {
          return status;
        },
        set: vi.fn().mockResolvedValue('OK'),
        eval: vi.fn(async (script: string) =>
          script === ACQUIRE_WITH_FENCE_LUA_SCRIPT
            ? 1
            : Promise.reject(new Error('ECONNRESET'))
        ),
      } as unknown as Redis;

      let capturedHandle: any = null;
      await expect(
        withDistributedLock(
          'task_error_during_drop',
          async (lock) => {
            capturedHandle = lock;
            status = 'close';
            throw new Error('Domain failure');
          },
          { redisClient: dropOnReleaseRedis }
        )
      ).rejects.toThrow('Domain failure');

      expect(capturedHandle?.isHeld).toBe(false);
    });
  });

  describe('acquireWithRetry & withDistributedLockRetry', () => {
    it('acquires immediately on attempt #1 without backoff delay', async () => {
      const lock = await acquireWithRetry('retry_immediate', 15_000, {
        redisClient: mockRedis as Redis,
        maxAttempts: 5,
        retryDelayMs: 50,
        backoffFactor: 1.5,
        jitter: 25,
      });

      expect(lock).not.toBeNull();
      expect(lock?.isHeld).toBe(true);
      expect(lock?.ttlMs).toBe(15_000);
      expect(mockRedis.set).toHaveBeenCalledTimes(1);

      await lock?.release();
    });

    it('acquires lock after 3 contested attempts using exponential backoff and jitter', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const holder = new DistributedLock('contended_job', {
        redisClient: mockRedis as Redis,
        ttlMs: 30_000,
      });
      await holder.acquire();

      let attemptCount = 0;
      const originalSet = mockRedis.set as unknown as (
        key: string,
        value: string,
        pxFlag?: string,
        ttlMs?: number,
        nxFlag?: string
      ) => Promise<'OK' | null>;
      mockRedis.set = vi.fn(
        async (key: string, value: string, pxFlag?: string, ttlMs?: number, nxFlag?: string) => {
          attemptCount++;
          if (attemptCount === 4) {
            await holder.release();
          }
          return originalSet(key, value, pxFlag, ttlMs, nxFlag);
        }
      ) as unknown as Redis['set'];

      const retryPromise = acquireWithRetry('contended_job', 20_000, {
        redisClient: mockRedis as Redis,
        maxAttempts: 5,
        retryDelayMs: 50,
        backoffFactor: 2,
        jitter: 20,
      });

      // Attempt 1 fails -> sleep 50 * 2^0 + 0.5 * 20 = 60ms
      await vi.advanceTimersByTimeAsync(60);
      expect(attemptCount).toBe(2);

      // Attempt 2 fails -> sleep 50 * 2^1 + 0.5 * 20 = 110ms
      await vi.advanceTimersByTimeAsync(110);
      expect(attemptCount).toBe(3);

      // Attempt 3 fails -> sleep 50 * 2^2 + 0.5 * 20 = 210ms -> Attempt 4 succeeds
      await vi.advanceTimersByTimeAsync(210);
      const acquired = await retryPromise;

      expect(acquired).not.toBeNull();
      expect(acquired?.isHeld).toBe(true);
      expect(attemptCount).toBe(4);

      await acquired?.release();
      randomSpy.mockRestore();
    });

    it('caps backoff delay at maxDelayMs', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const holder = new DistributedLock('capped_backoff', { redisClient: mockRedis as Redis });
      await holder.acquire();

      const retryPromise = acquireWithRetry('capped_backoff', 10_000, {
        redisClient: mockRedis as Redis,
        maxAttempts: 4,
        retryDelayMs: 100,
        maxDelayMs: 150,
        backoffFactor: 3,
        jitter: 0,
      });

      // Attempt 0 fails -> sleep min(150, 100) = 100ms
      await vi.advanceTimersByTimeAsync(100);
      expect(mockRedis.set).toHaveBeenCalledTimes(3); // 1 holder + 2 retry attempts

      // Attempt 1 fails -> sleep min(150, 300) = 150ms
      await vi.advanceTimersByTimeAsync(149);
      expect(mockRedis.set).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(mockRedis.set).toHaveBeenCalledTimes(4);

      // Attempt 2 fails -> sleep min(150, 900) = 150ms -> Attempt 3 fails -> null
      await vi.advanceTimersByTimeAsync(150);
      const result = await retryPromise;
      expect(result).toBeNull();
      expect(mockRedis.set).toHaveBeenCalledTimes(5);

      randomSpy.mockRestore();
    });

    it('aborts and returns null when timeoutMs expires while lock is permanently held', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const holder = new DistributedLock('permanent_lock', {
        redisClient: mockRedis as Redis,
        ttlMs: 60_000,
      });
      await holder.acquire();

      const retryPromise = acquireWithRetry('permanent_lock', 10_000, {
        redisClient: mockRedis as Redis,
        maxAttempts: 10,
        retryDelayMs: 100,
        backoffFactor: 2,
        jitter: 0,
        timeoutMs: 250,
      });

      // Attempt 0 at t=0 (100ms sleep), Attempt 1 at t=100 (150ms remaining capped sleep), timeout at t=250
      await vi.advanceTimersByTimeAsync(250);
      const result = await retryPromise;

      expect(result).toBeNull();
      // Only 1 holder set + 2 attempts before timeoutMs elapsed
      expect(mockRedis.set).toHaveBeenCalledTimes(3);

      randomSpy.mockRestore();
    });

    it('cancels cleanly during retry backoff when AbortSignal fires', async () => {
      const controller = new AbortController();
      const holder = new DistributedLock('abort_job', { redisClient: mockRedis as Redis });
      await holder.acquire();

      const retryPromise = acquireWithRetry('abort_job', 10_000, {
        redisClient: mockRedis as Redis,
        maxAttempts: 5,
        retryDelayMs: 500,
        jitter: 0,
        abortSignal: controller.signal,
      });

      // Advance partway through the first backoff sleep, then abort
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();

      const result = await retryPromise;
      expect(result).toBeNull();
      // 1 holder + 1 attempt before abort; no further attempts or dangling timers
      expect(mockRedis.set).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('returns null immediately if AbortSignal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await acquireWithRetry('pre_aborted', 10_000, {
        redisClient: mockRedis as Redis,
        abortSignal: controller.signal,
      });

      expect(result).toBeNull();
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it('withDistributedLockRetry runs critical section after contention and releases lock', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const holder = new DistributedLock('retry_wrapper_job', { redisClient: mockRedis as Redis });
      await holder.acquire();

      const taskPromise = withDistributedLockRetry(
        'retry_wrapper_job',
        async (lock) => {
          expect(lock.isHeld).toBe(true);
          return 'ok';
        },
        {
          redisClient: mockRedis as Redis,
          maxAttempts: 4,
          retryDelayMs: 50,
          backoffFactor: 2,
          jitter: 0,
        }
      );

      // Attempt 0 fails -> 50ms sleep -> release holder before attempt 1
      await vi.advanceTimersByTimeAsync(25);
      await holder.release();
      await vi.advanceTimersByTimeAsync(25);

      const outcome = await taskPromise;
      expect(outcome).toEqual({ executed: true, result: 'ok' });

      // Lock must have been released automatically after task completion
      const postCheck = new DistributedLock('retry_wrapper_job', { redisClient: mockRedis as Redis });
      expect(await postCheck.acquire()).toBe(true);

      randomSpy.mockRestore();
    });

    it('withDistributedLockRetry reports timeout and aborted reasons when acquisition fails', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const holder = new DistributedLock('retry_reason_job', { redisClient: mockRedis as Redis });
      await holder.acquire();

      const timeoutPromise = withDistributedLockRetry(
        'retry_reason_job',
        async () => 'never',
        {
          redisClient: mockRedis as Redis,
          maxAttempts: 5,
          retryDelayMs: 100,
          jitter: 0,
          timeoutMs: 150,
        }
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(await timeoutPromise).toEqual({ executed: false, reason: 'timeout' });

      const controller = new AbortController();
      const abortPromise = withDistributedLockRetry(
        'retry_reason_job',
        async () => 'never',
        {
          redisClient: mockRedis as Redis,
          maxAttempts: 5,
          retryDelayMs: 200,
          jitter: 0,
          abortSignal: controller.signal,
        }
      );
      await vi.advanceTimersByTimeAsync(50);
      controller.abort();
      expect(await abortPromise).toEqual({ executed: false, reason: 'aborted' });

      randomSpy.mockRestore();
    });
  });

  describe('Monotonic Fencing Tokens & Redlock Multi-Node Quorum', () => {
    function createInMemoryRedisNode(): {
      redis: Redis;
      store: Map<string, RedisEntry>;
      counters: Map<string, number>;
    } {
      const store = new Map<string, RedisEntry>();
      const counters = new Map<string, number>();
      const live = (key: string) => {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= currentTime) {
          store.delete(key);
          return null;
        }
        return entry;
      };
      const redis = {
        status: 'ready',
        set: vi.fn(async (key: string, value: string, px?: string, ttlMs?: number, nx?: string) => {
          if (nx === 'NX' && live(key)) return null;
          store.set(key, {
            value,
            expiresAt: px === 'PX' && typeof ttlMs === 'number' ? currentTime + ttlMs : Infinity,
          });
          return 'OK';
        }),
        incr: vi.fn(async (key: string) => {
          const next = (counters.get(key) ?? 0) + 1;
          counters.set(key, next);
          return next;
        }),
        eval: vi.fn(async (script: string, _numKeys: number, ...args: Array<string | number>) => {
          if (script === ACQUIRE_WITH_FENCE_LUA_SCRIPT) {
            const lockKey = String(args[0]);
            const fenceKey = String(args[1]);
            const owner = String(args[2]);
            const ttlMs = Number(args[3]);
            if (live(lockKey)) return 0;
            store.set(lockKey, { value: owner, expiresAt: currentTime + ttlMs });
            const next = (counters.get(fenceKey) ?? 0) + 1;
            counters.set(fenceKey, next);
            return next;
          }
          const key = String(args[0]);
          const entry = live(key);
          if (script === RELEASE_LOCK_LUA_SCRIPT) {
            if (entry && entry.value === String(args[1])) {
              store.delete(key);
              return 1;
            }
            return 0;
          }
          if (script === EXTEND_LOCK_LUA_SCRIPT) {
            if (entry && entry.value === String(args[1])) {
              entry.expiresAt = currentTime + Number(args[2]);
              return 1;
            }
            return 0;
          }
          return 0;
        }),
      } as unknown as Redis;
      return { redis, store, counters };
    }

    it('formats lock:fence:<resource> keys and issues strictly increasing fencing tokens', async () => {
      expect(formatFenceKey('xp_ledger')).toBe(`${DEFAULT_FENCE_PREFIX}xp_ledger`);
      expect(formatFenceKey(`${DEFAULT_LOCK_PREFIX}xp_ledger`)).toBe(`${DEFAULT_FENCE_PREFIX}xp_ledger`);

      const lock1 = await acquireDistributedLock('xp_ledger', { redisClient: mockRedis as Redis, ttlMs: 5_000 });
      expect(lock1?.fencingToken).toBe(1);

      // Blocked acquire returns null
      const blocked = await acquireDistributedLock('xp_ledger', { redisClient: mockRedis as Redis, ttlMs: 5_000 });
      expect(blocked).toBeNull();

      await lock1?.release();

      const lock2 = await acquireDistributedLock('xp_ledger', { redisClient: mockRedis as Redis, ttlMs: 5_000 });
      expect(lock2?.fencingToken).toBe(2);

      // Even after TTL expiration without release, next token strictly increases
      currentTime += 6_000;
      vi.setSystemTime(currentTime);
      const lock3 = await acquireDistributedLock('xp_ledger', { redisClient: mockRedis as Redis, ttlMs: 5_000 });
      expect(lock3?.fencingToken).toBe(3);
      expect(lock3!.fencingToken!).toBeGreaterThan(lock2!.fencingToken!);
      await lock3?.release();
    });

    it('supports partial Redis mocks using set + incr when eval is unavailable on acquire', async () => {
      const incrSpy = vi.fn().mockResolvedValueOnce(1041).mockResolvedValueOnce(1042);
      const partialRedis = {
        status: 'ready',
        set: vi.fn().mockResolvedValue('OK'),
        incr: incrSpy,
      } as unknown as Redis;

      const l1 = await acquireDistributedLock('profile_rebuild', { redisClient: partialRedis });
      const l2 = await acquireDistributedLock('profile_rebuild', { redisClient: partialRedis });

      expect(l1?.fencingToken).toBe(1041);
      expect(l2?.fencingToken).toBe(1042);
      expect(incrSpy).toHaveBeenCalledWith(`${DEFAULT_FENCE_PREFIX}profile_rebuild`);
    });

    it('auto-renews at default ttl/3 intervals when autoRenew is enabled', async () => {
      const lock = await acquireDistributedLock('auto_renew_default', {
        redisClient: mockRedis as Redis,
        ttlMs: 3_000,
        autoRenew: true,
      });
      expect(lock).not.toBeNull();

      // Advance across multiple ttl/3 (1_000ms) heartbeats past original 3_000ms TTL
      for (let i = 0; i < 4; i++) {
        currentTime += 1_000;
        vi.setSystemTime(currentTime);
        await vi.advanceTimersByTimeAsync(1_000);
      }

      const competitor = await acquireDistributedLock('auto_renew_default', {
        redisClient: mockRedis as Redis,
      });
      expect(competitor).toBeNull();

      await lock?.release();
      const afterRelease = await acquireDistributedLock('auto_renew_default', {
        redisClient: mockRedis as Redis,
      });
      expect(afterRelease).not.toBeNull();
      await afterRelease?.release();
    });

    it('acquires with majority Redlock quorum even when one of three nodes is down', async () => {
      const n1 = createInMemoryRedisNode();
      const n2 = createInMemoryRedisNode();
      const n3 = createInMemoryRedisNode();
      (n3.redis as { status: string }).status = 'reconnecting';

      const handle = await acquireDistributedLock('redlock_quorum_job', {
        redisClients: [n1.redis, n2.redis, n3.redis],
        ttlMs: 10_000,
      });

      expect(handle).not.toBeNull();
      expect(handle?.isHeld).toBe(true);
      expect(handle?.fencingToken).toBe(1);
      expect(n1.store.has(`${DEFAULT_LOCK_PREFIX}redlock_quorum_job`)).toBe(true);
      expect(n2.store.has(`${DEFAULT_LOCK_PREFIX}redlock_quorum_job`)).toBe(true);

      // Extend succeeds on 2/3 quorum
      expect(await handle?.extend(12_000)).toBe(true);
      // Release cleans both held nodes
      expect(await handle?.release()).toBe(true);
      expect(n1.store.size).toBe(0);
      expect(n2.store.size).toBe(0);
    });

    it('fails Redlock acquisition and rolls back partial locks when quorum is not reached', async () => {
      const n1 = createInMemoryRedisNode();
      const n2 = createInMemoryRedisNode();
      const n3 = createInMemoryRedisNode();

      // Contend on n2 and n3 so only n1 is free (< quorum of 2)
      n2.store.set(`${DEFAULT_LOCK_PREFIX}redlock_rollback`, { value: 'other', expiresAt: currentTime + 10_000 });
      n3.store.set(`${DEFAULT_LOCK_PREFIX}redlock_rollback`, { value: 'other', expiresAt: currentTime + 10_000 });

      const handle = await acquireDistributedLock('redlock_rollback', {
        redisClients: [n1.redis, n2.redis, n3.redis],
        ttlMs: 10_000,
      });

      expect(handle).toBeNull();
      // Node 1 partial acquisition must have been rolled back
      expect(n1.store.has(`${DEFAULT_LOCK_PREFIX}redlock_rollback`)).toBe(false);
    });

    it('rejects Redlock acquisition when clock drift leaves non-positive validity time', async () => {
      const n1 = createInMemoryRedisNode();
      const n2 = createInMemoryRedisNode();
      const n3 = createInMemoryRedisNode();

      const handle = await acquireDistributedLock('redlock_drift_expired', {
        redisClients: [n1.redis, n2.redis, n3.redis],
        ttlMs: 2, // driftMs = ceil + 2 leaves validityMs <= 0
        clockDriftFactor: 0.5,
      });

      expect(handle).toBeNull();
      expect(n1.store.size).toBe(0);
      expect(n2.store.size).toBe(0);
      expect(n3.store.size).toBe(0);
    });

    it('maintains mutual exclusion and strictly increasing tokens under concurrent worker contention', async () => {
      const n1 = createInMemoryRedisNode();
      const observedTokens: number[] = [];

      const results = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const lock = await acquireDistributedLock('stress_mutex', {
            redisClient: n1.redis,
            ttlMs: 5_000,
          });
          if (!lock) return false;
          observedTokens.push(lock.fencingToken!);
          return true;
        })
      );

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(observedTokens).toEqual([1]);
    });
  });
});
