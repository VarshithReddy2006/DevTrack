// src/shared/redis/index.ts — Redis module barrel
export { getRedisClient, getRedisClient as getRedisConnection, disconnectRedis, getRedisHealth, isRedisConfigured } from './client.js';
export type { RedisHealth } from './client.js';
export * from './distributedLock.js';
