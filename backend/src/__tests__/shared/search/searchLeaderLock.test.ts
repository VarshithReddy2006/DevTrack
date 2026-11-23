// src/__tests__/shared/search/searchLeaderLock.test.ts
// Unit tests for the Redis distributed leader lease and ownership fencing.

import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type Redis from 'ioredis';
import {
  RedisLeaderLock,
  RENEW_LEASE_LUA_SCRIPT,
  RELEASE_LEASE_LUA_SCRIPT,
  DEFAULT_SEARCH_LEADER_LOCK_KEY,
} from '../../../shared/search/searchLeaderLock.js';

interface RedisEntry {
  value: string;
  expiresAt: number;
}

describe('RedisLeaderLock', () => {
  let memoryStore: Map<string, RedisEntry>;
  let mockRedis: Partial<Redis>;
  let currentTime: number;

  beforeEach(() => {
    vi.useFakeTimers();
    currentTime = 100_000;
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
      set: vi.fn(async (key: string, value: string, pxFlag?: string, ttlMs?: number, nxFlag?: string) => {
        if (nxFlag === 'NX') {
          const existing = getLiveEntry(key);
          if (existing) {
            return null; // Key already exists and is active
          }
        }
        const expiresAt = pxFlag === 'PX' && typeof ttlMs === 'number'
          ? currentTime + ttlMs
          : Infinity;

        memoryStore.set(key, { value, expiresAt });
        return 'OK';
      }),

      eval: vi.fn(async (script: string, numKeys: number, ...args: Array<string | number>) => {
        const key = String(args[0]);
        const entry = getLiveEntry(key);

        if (script === RENEW_LEASE_LUA_SCRIPT) {
          const ownerToken = String(args[1]);
          const newTtlMs = Number(args[2]);

          if (entry && entry.value === ownerToken) {
            entry.expiresAt = currentTime + newTtlMs;
            return 1;
          }
          return 0;
        }

        if (script === RELEASE_LEASE_LUA_SCRIPT) {
          const ownerToken = String(args[1]);

          if (entry && entry.value === ownerToken) {
            memoryStore.delete(key);
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

  describe('Initial Acquisition & Exclusivity', () => {
    it('successfully acquires lease when no active owner exists', async () => {
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });

      expect(lock.isHeld).toBe(false);
      const acquired = await lock.acquire();

      expect(acquired).toBe(true);
      expect(lock.isHeld).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith(
        DEFAULT_SEARCH_LEADER_LOCK_KEY,
        lock.ownerToken,
        'PX',
        10_000,
        'NX'
      );
    });

    it('prevents a second worker from acquiring while the lease is actively held', async () => {
      const worker1 = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });
      const worker2 = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });

      expect(await worker1.acquire()).toBe(true);
      expect(worker1.isHeld).toBe(true);

      // Worker 2 attempts acquisition while worker 1 holds active lease
      const acquiredBy2 = await worker2.acquire();
      expect(acquiredBy2).toBe(false);
      expect(worker2.isHeld).toBe(false);
    });

    it('allows a second worker to acquire after the prior lease expires', async () => {
      const worker1 = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 5_000 });
      const worker2 = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 5_000 });

      expect(await worker1.acquire()).toBe(true);

      // Advance clock past worker 1's TTL
      currentTime += 5_001;
      vi.setSystemTime(currentTime);

      // Worker 2 can now acquire
      expect(await worker2.acquire()).toBe(true);
      expect(worker2.isHeld).toBe(true);
    });
  });

  describe('Atomic Renewal & Fencing Semantics', () => {
    it('allows the current owner to atomically renew the lease TTL', async () => {
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });
      await lock.acquire();

      // Advance time by 3 seconds
      currentTime += 3_000;
      vi.setSystemTime(currentTime);

      const renewed = await lock.renew();
      expect(renewed).toBe(true);
      expect(lock.isHeld).toBe(true);

      const entry = memoryStore.get(DEFAULT_SEARCH_LEADER_LOCK_KEY);
      expect(entry?.expiresAt).toBe(currentTime + 10_000);
    });

    it('RENEWAL FENCING: rejects renewal if lease was stolen/acquired by another worker', async () => {
      const worker1 = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 5_000 });
      const worker2 = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 5_000 });

      await worker1.acquire();

      // Worker 1 pauses, lease expires
      currentTime += 5_001;
      vi.setSystemTime(currentTime);

      // Worker 2 acquires the lease
      await worker2.acquire();

      // Worker 1 wakes up and attempts renewal — MUST FAIL
      const renewedBy1 = await worker1.renew();
      expect(renewedBy1).toBe(false);
      expect(worker1.isHeld).toBe(false);

      // Verify worker 2 still owns the lease and its token is untouched
      const entry = memoryStore.get(DEFAULT_SEARCH_LEADER_LOCK_KEY);
      expect(entry?.value).toBe(worker2.ownerToken);
    });

    it('rejects renewal if lease has expired and no successor exists', async () => {
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 5_000 });
      await lock.acquire();

      currentTime += 6_000;
      vi.setSystemTime(currentTime);

      const renewed = await lock.renew();
      expect(renewed).toBe(false);
      expect(lock.isHeld).toBe(false);
    });

    it('rejects renewal by a worker that never acquired the lease', async () => {
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });
      const renewed = await lock.renew();
      expect(renewed).toBe(false);
      expect(lock.isHeld).toBe(false);
    });
  });

  describe('Atomic Release & Stale Owner Protection', () => {
    it('allows the current owner to cleanly release the lease', async () => {
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });
      await lock.acquire();

      const released = await lock.release();
      expect(released).toBe(true);
      expect(lock.isHeld).toBe(false);
      expect(memoryStore.has(DEFAULT_SEARCH_LEADER_LOCK_KEY)).toBe(false);
    });

    it('STALE RELEASE FENCING: stale worker cannot release a successor worker lease', async () => {
      const worker1 = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 4_000 });
      const worker2 = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });

      await worker1.acquire();

      // Worker 1 hangs; lease expires
      currentTime += 4_001;
      vi.setSystemTime(currentTime);

      // Worker 2 acquires the lease
      await worker2.acquire();
      expect(worker2.isHeld).toBe(true);

      // Worker 1 resumes and calls release() — MUST FAIL and MUST NOT delete worker 2's lease
      const releasedByStale = await worker1.release();
      expect(releasedByStale).toBe(false);
      expect(worker1.isHeld).toBe(false);

      // Assert worker 2's lease is still intact
      const entry = memoryStore.get(DEFAULT_SEARCH_LEADER_LOCK_KEY);
      expect(entry).toBeDefined();
      expect(entry?.value).toBe(worker2.ownerToken);
      expect(worker2.isHeld).toBe(true);
    });

    it('returns false when releasing an already expired or non-existent lease', async () => {
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 5_000 });
      await lock.acquire();

      currentTime += 5_001;
      vi.setSystemTime(currentTime);

      const released = await lock.release();
      expect(released).toBe(false);
      expect(lock.isHeld).toBe(false);
    });
  });

  describe('Heartbeat Lifecycle & Lost-Lease Notification', () => {
    it('periodically renews the lease at heartbeat interval', async () => {
      const lock = new RedisLeaderLock({
        redisClient: mockRedis as Redis,
        ttlMs: 10_000,
        heartbeatMs: 2_000,
      });

      await lock.acquire();
      lock.startHeartbeat();

      // Advance by 2 seconds
      currentTime += 2_000;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(mockRedis.eval).toHaveBeenCalledWith(
        RENEW_LEASE_LUA_SCRIPT,
        1,
        DEFAULT_SEARCH_LEADER_LOCK_KEY,
        lock.ownerToken,
        10_000
      );

      lock.stopHeartbeat();
    });

    it('invokes onLost callback when heartbeat renewal fails due to ownership loss', async () => {
      const onLost = vi.fn();
      const lock = new RedisLeaderLock({
        redisClient: mockRedis as Redis,
        ttlMs: 5_000,
        heartbeatMs: 2_000,
      });

      await lock.acquire();
      lock.startHeartbeat(onLost);

      // Simulate lock being stolen/deleted before next heartbeat
      memoryStore.delete(DEFAULT_SEARCH_LEADER_LOCK_KEY);

      currentTime += 2_000;
      await vi.advanceTimersByTimeAsync(2_000);

      expect(onLost).toHaveBeenCalledTimes(1);
      expect(lock.isHeld).toBe(false);
    });
  });

  describe('Concurrency & Race Conditions', () => {
    it('ensures only 1 of 5 concurrent workers acquires the lease', async () => {
      const workers = Array.from({ length: 5 }, () =>
        new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 })
      );

      const results = await Promise.all(workers.map(w => w.acquire()));
      const winners = results.filter(r => r === true);

      expect(winners.length).toBe(1);
      const winner = workers.find(w => w.isHeld);
      expect(winner).toBeDefined();
    });

    it('ensures concurrent release by stale owner and valid owner works deterministically', async () => {
      const validWorker = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });
      const staleWorker = new RedisLeaderLock({ redisClient: mockRedis as Redis, ttlMs: 10_000 });

      await validWorker.acquire();

      const [staleResult, validResult] = await Promise.all([
        staleWorker.release(),
        validWorker.release(),
      ]);

      expect(staleResult).toBe(false);
      expect(validResult).toBe(true);
      expect(memoryStore.has(DEFAULT_SEARCH_LEADER_LOCK_KEY)).toBe(false);
    });
  });

  describe('Redis Error Handling', () => {
    it('propagates Redis failure during acquire', async () => {
      (mockRedis.set as any).mockRejectedValueOnce(new Error('Connection dropped'));
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis });

      await expect(lock.acquire()).rejects.toThrow('Connection dropped');
      expect(lock.isHeld).toBe(false);
    });

    it('propagates Redis failure during renew', async () => {
      (mockRedis.eval as any).mockRejectedValueOnce(new Error('Redis cluster down'));
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis });

      await expect(lock.renew()).rejects.toThrow('Redis cluster down');
      expect(lock.isHeld).toBe(false);
    });

    it('propagates Redis failure during release', async () => {
      (mockRedis.eval as any).mockRejectedValueOnce(new Error('Network partition'));
      const lock = new RedisLeaderLock({ redisClient: mockRedis as Redis });

      await expect(lock.release()).rejects.toThrow('Network partition');
      expect(lock.isHeld).toBe(false);
    });
  });
});
