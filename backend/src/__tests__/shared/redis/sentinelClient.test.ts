// src/__tests__/shared/redis/sentinelClient.test.ts — Unit tests for Redis Sentinel client

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const redisTestState = vi.hoisted(() => ({
  onCreate: null as ((instance: any) => void) | null,
}));

vi.mock('ioredis', () => {
  class MockRedis {
    status = 'ready';
    options: Record<string, unknown>;
    on = vi.fn().mockImplementation((event: string, callback: () => void) => {
      if (event === 'connect' || event === 'ready') {
        setTimeout(() => callback && callback(), 10);
      }
      return this;
    });
    connect = vi.fn().mockResolvedValue(undefined);
    quit = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    pipeline = vi.fn().mockReturnValue({
      del: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      get: vi.fn().mockReturnThis(),
      incr: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });
    multi = vi.fn().mockReturnValue({
      del: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    });

    constructor(config: Record<string, unknown> = {}) {
      this.options = config;
      redisTestState.onCreate?.(this);
    }
  }
  return { default: MockRedis, Redis: MockRedis };
});

import Redis from 'ioredis';
import { 
  isSentinelConfigured, 
  getRedisMaster, 
  getRedisReplica, 
  getSentinelHealth, 
  disconnectSentinel,
  resetSentinelClients,
  parseSentinelHosts,
  isClientAlive,
  isReadonlyError,
  findReadonlyErrorInPipelineResults,
  refreshSentinelMaster,
  executeWithFailover,
  executePipelineWithFailover,
  executeTransactionWithFailover,
  SentinelFailoverError,
} from '../../../shared/redis/sentinelClient.js';
import {
  executeRedisPipeline,
  executeRedisTransaction,
} from '../../../shared/redis/client.js';

// Mock environment variables
const originalEnv = { ...process.env };

describe('sentinelClient', () => {
  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    redisTestState.onCreate = null;
    resetSentinelClients();
    vi.clearAllMocks();
  });

  afterEach(() => {
    redisTestState.onCreate = null;
    resetSentinelClients();
    process.env = originalEnv;
  });

  describe('parseSentinelHosts', () => {
    it('should parse empty string as empty array', () => {
      expect(parseSentinelHosts('')).toEqual([]);
    });

    it('should parse single host:port', () => {
      expect(parseSentinelHosts('localhost:26379')).toEqual([
        { host: 'localhost', port: 26379 }
      ]);
    });

    it('should parse multiple host:port pairs', () => {
      expect(parseSentinelHosts('sentinel1:26379,sentinel2:26380,sentinel3:26381')).toEqual([
        { host: 'sentinel1', port: 26379 },
        { host: 'sentinel2', port: 26380 },
        { host: 'sentinel3', port: 26381 }
      ]);
    });

    it('should handle missing port (default to 26379)', () => {
      expect(parseSentinelHosts('sentinel1')).toEqual([
        { host: 'sentinel1', port: 26379 }
      ]);
    });

    it('should trim whitespace', () => {
      expect(parseSentinelHosts(' sentinel1:26379 , sentinel2:26380 ')).toEqual([
        { host: 'sentinel1', port: 26379 },
        { host: 'sentinel2', port: 26380 }
      ]);
    });
  });

  describe('isSentinelConfigured', () => {
    it('should return false when REDIS_SENTINEL_HOSTS is not set', () => {
      delete process.env.REDIS_SENTINEL_HOSTS;
      expect(isSentinelConfigured()).toBe(false);
    });

    it('should return false when REDIS_SENTINEL_HOSTS is empty string', () => {
      process.env.REDIS_SENTINEL_HOSTS = '';
      expect(isSentinelConfigured()).toBe(false);
    });

    it('should return true when REDIS_SENTINEL_HOSTS is set', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      expect(isSentinelConfigured()).toBe(true);
    });
  });

  describe('getRedisMaster', () => {
    it('should throw error when Sentinel is not configured', () => {
      delete process.env.REDIS_SENTINEL_HOSTS;
      expect(() => getRedisMaster()).toThrow('Redis Sentinel is not configured');
    });

    it('should create master client when Sentinel is configured', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';
      
      const client = getRedisMaster();
      expect(client).toBeInstanceOf(Redis);
    });

    it('should return same client instance on subsequent calls', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';
      
      const client1 = getRedisMaster();
      const client2 = getRedisMaster();
      expect(client1).toBe(client2);
    });
  });

  describe('getRedisReplica', () => {
    it('should throw error when Sentinel is not configured', () => {
      delete process.env.REDIS_SENTINEL_HOSTS;
      expect(() => getRedisReplica()).toThrow('Redis Sentinel is not configured');
    });

    it('should create replica client when Sentinel is configured', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';
      
      const client = getRedisReplica();
      expect(client).toBeInstanceOf(Redis);
    });

    it('should return same client instance on subsequent calls', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';
      
      const client1 = getRedisReplica();
      const client2 = getRedisReplica();
      expect(client1).toBe(client2);
    });
  });

  describe('getSentinelHealth', () => {
    it('should return disconnected status when no clients exist', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';
      
      const health = getSentinelHealth();
      expect(health.status).toBe('disconnected');
      expect(health.masterHost).toBeNull();
      expect(health.replicaHost).toBeNull();
      expect(health.sentinelCount).toBe(1);
    });

    it('should count sentinel hosts correctly', () => {
      process.env.REDIS_SENTINEL_HOSTS = 's1:26379,s2:26379,s3:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';
      
      const health = getSentinelHealth();
      expect(health.sentinelCount).toBe(3);
    });
  });

  describe('resetSentinelClients', () => {
    it('should reset all client references', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';
      
      const client1 = getRedisMaster();
      const client2 = getRedisReplica();
      
      expect(client1).toBeInstanceOf(Redis);
      expect(client2).toBeInstanceOf(Redis);
      
      resetSentinelClients();
      
      // Should create new instances after reset
      const newMaster = getRedisMaster();
      const newReplica = getRedisReplica();
      
      // New instances should be different from old ones
      expect(newMaster).not.toBe(client1);
      expect(newReplica).not.toBe(client2);
    });
  });

  describe('isClientAlive and reconnection lifecycle', () => {
    it('should identify valid transitional states as alive', () => {
      expect(isClientAlive(null)).toBe(false);
      expect(isClientAlive({ status: 'close' } as any)).toBe(false);
      expect(isClientAlive({ status: 'end' } as any)).toBe(false);

      expect(isClientAlive({ status: 'ready' } as any)).toBe(true);
      expect(isClientAlive({ status: 'connecting' } as any)).toBe(true);
      expect(isClientAlive({ status: 'connect' } as any)).toBe(true);
      expect(isClientAlive({ status: 'wait' } as any)).toBe(true);
      expect(isClientAlive({ status: 'reconnecting' } as any)).toBe(true);
    });

    it('should reuse master and replica clients while in reconnecting state', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';

      const master = getRedisMaster();
      const replica = getRedisReplica();

      // Simulate network blip / failover where ioredis enters reconnecting status
      Object.defineProperty(master, 'status', { value: 'reconnecting', configurable: true });
      Object.defineProperty(replica, 'status', { value: 'reconnecting', configurable: true });

      const secondMaster = getRedisMaster();
      const secondReplica = getRedisReplica();

      // Must not instantiate new clients during reconnecting status
      expect(secondMaster).toBe(master);
      expect(secondReplica).toBe(replica);
    });

    it('should map reconnecting and connecting states to connecting in getSentinelHealth', () => {
      process.env.REDIS_SENTINEL_HOSTS = 'localhost:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';

      const master = getRedisMaster();
      Object.defineProperty(master, 'status', { value: 'reconnecting', configurable: true });

      const health = getSentinelHealth();
      expect(health.status).toBe('connecting');
    });
  });

  describe('READONLY detection and Sentinel failover pipeline retry', () => {
    it('detects READONLY errors across error objects, strings, and pipeline tuples', () => {
      expect(isReadonlyError(new Error("READONLY You can't write against a read only replica."))).toBe(true);
      expect(isReadonlyError('ERR readonly replica')).toBe(true);
      expect(isReadonlyError(new Error('WRONGTYPE Operation against a key'))).toBe(false);
      expect(isReadonlyError(null)).toBe(false);

      const roErr = new Error("READONLY You can't write against a read only replica");
      expect(findReadonlyErrorInPipelineResults([[null, 'OK'], [roErr, null]])).toBe(roErr);
      expect(findReadonlyErrorInPipelineResults([[new Error('WRONGTYPE'), null]])).toBeNull();
      expect(findReadonlyErrorInPipelineResults(null)).toBeNull();
    });

    it('refreshes master and replica clients cleanly and coalesces concurrent refreshes', async () => {
      process.env.REDIS_SENTINEL_HOSTS = 'sentinel1:26379,sentinel2:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';

      const oldMaster = getRedisMaster();
      const oldReplica = getRedisReplica();
      const oldMasterDisconnect = vi.fn();
      const oldReplicaDisconnect = vi.fn();
      (oldMaster as any).disconnect = oldMasterDisconnect;
      (oldReplica as any).disconnect = oldReplicaDisconnect;

      const [refreshed1, refreshed2] = await Promise.all([
        refreshSentinelMaster(),
        refreshSentinelMaster(),
      ]);

      expect(refreshed1).toBe(refreshed2);
      expect(refreshed1).not.toBe(oldMaster);
      expect(oldMasterDisconnect).toHaveBeenCalledTimes(1);
      expect(oldReplicaDisconnect).toHaveBeenCalledTimes(1);
    });

    it('recovers a pipeline when READONLY is returned inside exec() tuple results during failover', async () => {
      process.env.REDIS_SENTINEL_HOSTS = 'sentinel1:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';

      let createdCount = 0;
      const createdMasters: any[] = [];
      redisTestState.onCreate = (instance) => {
        createdCount++;
        createdMasters.push(instance);
        if (createdCount === 1) {
          instance.pipeline = vi.fn().mockReturnValue({
            set: vi.fn().mockReturnThis(),
            incr: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([
              [null, 'OK'],
              [new Error("READONLY You can't write against a read only replica."), null],
            ]),
          });
        } else {
          instance.pipeline = vi.fn().mockReturnValue({
            set: vi.fn().mockReturnThis(),
            incr: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([
              [null, 'OK'],
              [null, 42],
            ]),
          });
        }
      };

      const onRetry = vi.fn();
      const results = await executePipelineWithFailover(
        (pipe) => {
          pipe.set('k', 'v').incr('counter');
        },
        { baseDelayMs: 1, maxDelayMs: 5, onRetry }
      );

      expect(createdMasters).toHaveLength(2);
      expect(createdMasters[0].disconnect).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(results).toEqual([
        [null, 'OK'],
        [null, 42],
      ]);
    });

    it('recovers a MULTI/EXEC transaction when exec() rejects with READONLY during failover', async () => {
      process.env.REDIS_SENTINEL_HOSTS = 'sentinel1:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';

      let createdCount = 0;
      redisTestState.onCreate = (instance) => {
        createdCount++;
        if (createdCount === 1) {
          instance.multi = vi.fn().mockReturnValue({
            del: vi.fn().mockReturnThis(),
            zadd: vi.fn().mockReturnThis(),
            exec: vi.fn().mockRejectedValue(
              new Error("READONLY You can't write against a read only replica")
            ),
          });
        } else {
          instance.multi = vi.fn().mockReturnValue({
            del: vi.fn().mockReturnThis(),
            zadd: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([
              [null, 1],
              [null, 2],
            ]),
          });
        }
      };

      const results = await executeTransactionWithFailover(
        (multi) => {
          multi.del('league:cohort').zadd('league:cohort', 100, 'user-1');
        },
        { baseDelayMs: 1, maxDelayMs: 5 }
      );

      expect(createdCount).toBe(2);
      expect(results).toEqual([
        [null, 1],
        [null, 2],
      ]);
    });

    it('retries up to maxRetries with exponential backoff and throws SentinelFailoverError when exhausted', async () => {
      process.env.REDIS_SENTINEL_HOSTS = 'sentinel1:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';

      const delays: number[] = [];
      const operation = vi.fn().mockRejectedValue(
        new Error("READONLY You can't write against a read only replica.")
      );

      let caught: unknown;
      try {
        await executeWithFailover(operation, {
          maxRetries: 3,
          baseDelayMs: 2,
          maxDelayMs: 20,
          onRetry: (_attempt, _err, delayMs) => delays.push(delayMs),
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(SentinelFailoverError);
      expect((caught as SentinelFailoverError).attempts).toBe(4);
      expect((caught as SentinelFailoverError).message).toContain('failed after 4 attempt(s)');
      expect((caught as SentinelFailoverError).cause.message).toContain('READONLY');
      expect(operation).toHaveBeenCalledTimes(4);
      expect(delays).toEqual([2, 4, 8]);
    });

    it('does not retry or refresh master on non-READONLY errors', async () => {
      process.env.REDIS_SENTINEL_HOSTS = 'sentinel1:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';

      const master = getRedisMaster();
      const disconnect = vi.fn();
      (master as any).disconnect = disconnect;
      (master as any).pipeline = vi.fn().mockReturnValue({
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([[new Error('WRONGTYPE Operation against a key'), null]]),
      });

      const res = await executePipelineWithFailover((p) => p.get('bad-key'), {
        baseDelayMs: 1,
      });
      expect(res?.[0][0]).toBeInstanceOf(Error);
      expect(disconnect).not.toHaveBeenCalled();

      await expect(
        executeWithFailover(async () => {
          throw new Error('ERR syntax error');
        }, { baseDelayMs: 1 })
      ).rejects.toThrow('ERR syntax error');
      expect(disconnect).not.toHaveBeenCalled();
    });

    it('routes client.ts pipeline and transaction helpers through Sentinel failover when configured', async () => {
      process.env.REDIS_SENTINEL_HOSTS = 'sentinel1:26379';
      process.env.REDIS_SENTINEL_MASTER_NAME = 'mymaster';

      let createdCount = 0;
      redisTestState.onCreate = (instance) => {
        createdCount++;
        if (createdCount === 1) {
          instance.pipeline = vi.fn().mockReturnValue({
            set: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([[new Error('READONLY replica'), null]]),
          });
        } else {
          instance.pipeline = vi.fn().mockReturnValue({
            set: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([[null, 'OK']]),
          });
          instance.multi = vi.fn().mockReturnValue({
            set: vi.fn().mockReturnThis(),
            exec: vi.fn().mockResolvedValue([[null, 'OK']]),
          });
        }
      };

      const pipeRes = await executeRedisPipeline((p) => {
        p.set('a', '1');
      }, { baseDelayMs: 1, maxDelayMs: 5 });
      expect(pipeRes).toEqual([[null, 'OK']]);

      const txRes = await executeRedisTransaction((m) => m.set('b', '2'));
      expect(txRes).toEqual([[null, 'OK']]);
      expect(createdCount).toBe(2);
    });
  });
});
