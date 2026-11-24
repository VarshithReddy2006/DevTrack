// src/__tests__/shared/redis/distributedLock.test.ts
// Unit and integration tests for distributed locking and ownership fencing.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type Redis from 'ioredis';
import {
  DistributedLock,
  acquireDistributedLock,
  releaseDistributedLock,
  extendDistributedLock,
  withDistributedLock,
  formatJobLockKey,
  RELEASE_LOCK_LUA_SCRIPT,
  EXTEND_LOCK_LUA_SCRIPT,
  DEFAULT_LOCK_PREFIX,
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
    });
  });
});
