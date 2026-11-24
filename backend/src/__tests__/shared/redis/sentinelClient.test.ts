// src/__tests__/shared/redis/sentinelClient.test.ts — Unit tests for Redis Sentinel client

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
} from '../../../shared/redis/sentinelClient.js';

// Mock environment variables
const originalEnv = { ...process.env };

describe('sentinelClient', () => {
  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };
    resetSentinelClients();
    vi.clearAllMocks();
  });

  afterEach(() => {
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
});
