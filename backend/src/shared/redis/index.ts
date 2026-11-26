// src/shared/redis/index.ts — Redis module barrel
export {
  getRedisClient,
  getRedisClient as getRedisConnection,
  disconnectRedis,
  getRedisHealth,
  isRedisConfigured,
  executeRedisOperation,
  executeRedisPipeline,
  executeRedisTransaction,
} from './client.js';
export type { RedisHealth } from './client.js';
export {
  SentinelFailoverError,
  isReadonlyError,
  refreshSentinelMaster,
  executeWithFailover,
  executePipelineWithFailover,
  executeTransactionWithFailover,
  type FailoverRetryOptions,
  type PipelineExecResult,
} from './sentinelClient.js';
export * from './distributedLock.js';
