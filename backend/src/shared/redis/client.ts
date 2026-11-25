// src/shared/redis/client.ts — Centralized Redis singleton via ioredis
// Manages connection lifecycle, reconnection, and health visibility.
// Integrates with Redis Sentinel for high availability when configured.

import Redis, { type ChainableCommander } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import {
  isSentinelConfigured,
  getRedisMaster,
  getSentinelHealth,
  isReadonlyError,
  executeWithFailover,
  executePipelineWithFailover,
  executeTransactionWithFailover,
  type FailoverRetryOptions,
  type PipelineExecResult,
} from './sentinelClient.js';

let _client: Redis | null = null;
let _mockClient: Redis | null = null;
let _connecting = false;

export interface RedisHealth {
  status: 'disconnected' | 'connecting' | 'connected';
  host: string;
  port: number;
  lastError: string | null;
  reconnectAttempts: number;
}

/**
 * Redis counts as configured when either REDIS_URL or an explicit REDIS_HOST is set.
 * REDIS_HOST has a localhost default in env.ts, so the raw process env is checked
 * to tell "set on purpose" apart from "left at the default".
 */
export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
}

/**
 * Open a new ioredis connection from REDIS_URL, or from REDIS_HOST / REDIS_PORT /
 * REDIS_PASSWORD when no URL is given. Used for the dedicated pub/sub connections.
 */
export function createRedisConnection(overrides: Record<string, unknown> = {}): Redis {
  const url = process.env.REDIS_URL;
  if (url) {
    return new Redis(url, { family: 0, ...overrides });
  }
  return new Redis({
    host: process.env.REDIS_HOST || env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT) || env.REDIS_PORT,
    password: process.env.REDIS_PASSWORD || env.REDIS_PASSWORD || undefined,
    ...overrides,
  });
}

export async function checkRedisEvictionPolicy(redis: Pick<Redis, 'config'>): Promise<void> {
  try {
    const config = await redis.config('GET', 'maxmemory-policy');
    const policy = Array.isArray(config) && config[0] === 'maxmemory-policy' ? config[1] : undefined;
    if (typeof policy !== 'string') {
      logger.warn('[redis] Could not verify maxmemory-policy; configure noeviction for BullMQ');
    } else if (policy !== 'noeviction') {
      logger.warn('[redis] BullMQ requires maxmemory-policy=noeviction', { policy });
    }
  } catch {
    logger.warn('[redis] CONFIG GET unavailable; verify that maxmemory-policy is noeviction for BullMQ');
  }
}

export function getRedisClient(): Redis {
  // If Redis Sentinel is configured, use the Sentinel master client
  if (isSentinelConfigured()) {
    logger.info('[redis] Using Redis Sentinel for high availability');
    return getRedisMaster();
  }

  // If Redis is not configured at all, return a mock client that doesn't connect
  if (!isRedisConfigured()) {
    if (_mockClient) return _mockClient;
    logger.warn('[redis] Neither REDIS_URL nor REDIS_HOST set - returning null client (Redis features disabled)');
    // Return a mock Redis instance that won't try to connect
    const mockClient = new Redis({
      host: 'localhost',
      port: 6379,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null, // Disable retries
    });
    // Swallow any connection error so it never causes unhandled 'error' events
    mockClient.on('error', () => {});
    // Prevent it from ever connecting
    mockClient.connect = () => Promise.reject(new Error('Redis disabled - REDIS_URL / REDIS_HOST not set'));
    mockClient.ping = (() => Promise.reject(new Error('Redis disabled - REDIS_URL / REDIS_HOST not set'))) as unknown as typeof mockClient.ping;
    _mockClient = mockClient;
    return mockClient;
  }

  if (
    _client &&
    (_client.status === 'ready' ||
      _client.status === 'connecting' ||
      _client.status === 'connect' ||
      _client.status === 'wait' ||
      _client.status === 'reconnecting')
  ) {
    return _client;
  }

  if (_connecting) {
    // Already initializing — return whatever client exists, or create a non-connecting stub
    if (_client) return _client;
  }

  _connecting = true;

  const redisUrl = process.env.REDIS_URL;
  const redisConfig = redisUrl
    ? {
        lazyConnect: true,
        maxRetriesPerRequest: null,
      }
    : {
        host: process.env.REDIS_HOST || env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT) || env.REDIS_PORT,
        password: process.env.REDIS_PASSWORD || env.REDIS_PASSWORD || undefined,
        lazyConnect: true,
        // BullMQ requires this to be null for blocking connections.
        maxRetriesPerRequest: null,
        retryStrategy(times: number) {
          const delay = Math.min(times * 100, 3000);
          logger.warn('[redis] Reconnecting', { attempt: times, delayMs: delay });
          return delay;
        },
        reconnectOnError(err: Error) {
          return isReadonlyError(err) ? 2 : false;
        },
      };

  if (redisUrl) {
    // Pass the full URL string to ioredis so it automatically handles the 'rediss://' TLS configuration
    _client = new Redis(redisUrl, {
      ...(redisConfig as Record<string, unknown>),
      family: 0, // Use IPv4/IPv6 dual-stack resolution, helpful in Docker
    });
  } else {
    _client = new Redis({
      ...(redisConfig as Record<string, unknown>),
      family: 0,
    });
  }

  _client.on('connect', () => {
    logger.info('[redis] Connected', {
      event: 'redis_connected',
      host: _client?.options?.host || 'unknown',
      port: _client?.options?.port || 6379,
    });
    _connecting = false;
  });

  const client = _client;
  if (env.NODE_ENV === 'production') {
    client.once('ready', () => void checkRedisEvictionPolicy(client));
  }

  _client.on('ready', () => {
    logger.info('[redis] Ready', {
      event: 'redis_ready',
      host: _client?.options?.host || 'unknown',
      port: _client?.options?.port || 6379,
    });
  });

  _client.on('error', (err: Error) => {
    logger.error('[redis] Error', err, {
      event: 'redis_error',
      host: _client?.options?.host || 'unknown',
      port: _client?.options?.port || 6379,
    });
    _connecting = false;
  });

  _client.on('close', () => {
    logger.warn('[redis] Connection closed', { event: 'redis_closed' });
  });

  _client.on('reconnecting', () => {
    logger.info('[redis] Reconnecting', { event: 'redis_reconnecting' });
  });

  // Attempt connection (non-blocking)
  void _client.connect().catch((err) => {
    logger.warn('[redis] Initial connect failed (will retry)', {
      error: err instanceof Error ? err.message : String(err),
    });
    _connecting = false;
  });

  return _client;
}

export async function disconnectRedis(): Promise<void> {
  const client = _client;
  if (!client) return;
  try {
    if (client.status === 'ready') await client.quit();
  } finally {
    client.disconnect();
    if (_client === client) {
      _client = null;
      _connecting = false;
    }
  }
  logger.info('[redis] Disconnected', { event: 'redis_disconnected' });
}

export function getRedisHealth(): RedisHealth {
  if (!_client) return { status: 'disconnected', host: env.REDIS_HOST, port: env.REDIS_PORT, lastError: null, reconnectAttempts: 0 };
  const statusMap: Record<string, 'connected' | 'connecting' | 'disconnected'> = {
    ready: 'connected',
    wait: 'connecting',
    connect: 'connecting',
    connecting: 'connecting',
    reconnecting: 'connecting',
    close: 'disconnected',
    end: 'disconnected',
  };
  return {
    status: statusMap[_client.status] ?? 'disconnected',
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    lastError: null,
    reconnectAttempts: 0,
  };
}

/**
 * Execute an operation against the active Redis client, automatically
 * handling Sentinel master failover and READONLY retries when Sentinel is configured.
 */
export async function executeRedisOperation<T>(
  operation: (client: Redis) => Promise<T>,
  options?: FailoverRetryOptions
): Promise<T> {
  if (isSentinelConfigured()) {
    return executeWithFailover(operation, options);
  }
  return operation(getRedisClient());
}

async function executeRedisBatch(
  mode: 'pipeline' | 'multi',
  build: (batch: ChainableCommander) => void,
  options?: FailoverRetryOptions
): Promise<PipelineExecResult> {
  if (isSentinelConfigured()) {
    return mode === 'multi'
      ? executeTransactionWithFailover(build, options)
      : executePipelineWithFailover(build, options);
  }
  const client = getRedisClient();
  const batch = mode === 'multi' ? client.multi() : client.pipeline();
  build(batch);
  return (await batch.exec()) as PipelineExecResult;
}

/**
 * Execute a multi-command Redis pipeline with automatic Sentinel failover retry
 * when Sentinel is configured.
 */
export function executeRedisPipeline(
  build: (pipeline: ChainableCommander) => void,
  options?: FailoverRetryOptions
): Promise<PipelineExecResult> {
  return executeRedisBatch('pipeline', build, options);
}

/**
 * Execute a Redis MULTI/EXEC transaction with automatic Sentinel failover retry
 * when Sentinel is configured.
 */
export function executeRedisTransaction(
  build: (multi: ChainableCommander) => void,
  options?: FailoverRetryOptions
): Promise<PipelineExecResult> {
  return executeRedisBatch('multi', build, options);
}