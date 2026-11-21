// src/modules/sync/tokenPoolManager.service.ts — Multi-token OAuth credential pool manager
// Rotates across configured platform tokens, tracks rate-limit quotas, and manages BullMQ backpressure.

import crypto from 'node:crypto';
import type { Queue } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../shared/logger.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';
import { getPlatformSyncQueue } from '../../shared/jobs/queueFactory.js';
import { QueueNames } from '../../shared/jobs/types.js';

export interface TokenStatus {
  id: string; // SHA-256 slice of token for safe logging & Redis keys
  platform: string;
  token: string;
  remaining: number;
  limit: number;
  resetEpochMs: number;
  inFlight: number;
  lastUsedAt: number;
}

export interface LeasedToken {
  token: string;
  id: string;
  platform: string;
  release: () => Promise<void>;
}

export interface RateLimitHeaders {
  remaining?: number;
  limit?: number;
  resetEpochMs?: number;
}

export class QuotaExhaustedError extends Error {
  public readonly platform: string;
  public readonly earliestResetMs: number;

  constructor(platform: string, earliestResetMs: number) {
    super(`All tokens exhausted for platform "${platform}". Earliest reset at ${new Date(earliestResetMs).toISOString()}`);
    this.name = 'QuotaExhaustedError';
    this.platform = platform;
    this.earliestResetMs = earliestResetMs;
  }
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function parseRateLimitHeaders(
  headers: Headers | Record<string, string | string[] | undefined> | undefined
): RateLimitHeaders {
  if (!headers) return {};

  const getHeader = (name: string): string | undefined => {
    if (typeof (headers as Headers).get === 'function') {
      return (headers as Headers).get(name) ?? undefined;
    }
    const record = headers as Record<string, string | string[] | undefined>;
    const direct = record[name] ?? record[name.toLowerCase()];
    if (Array.isArray(direct)) return direct[0];
    return direct;
  };

  const remainingRaw = getHeader('x-ratelimit-remaining') ?? getHeader('ratelimit-remaining');
  const limitRaw = getHeader('x-ratelimit-limit') ?? getHeader('ratelimit-limit');
  const resetRaw = getHeader('x-ratelimit-reset') ?? getHeader('ratelimit-reset');
  const retryAfterRaw = getHeader('retry-after');

  const result: RateLimitHeaders = {};

  if (remainingRaw !== undefined) {
    const val = parseInt(remainingRaw, 10);
    if (!Number.isNaN(val)) result.remaining = val;
  }

  if (limitRaw !== undefined) {
    const val = parseInt(limitRaw, 10);
    if (!Number.isNaN(val)) result.limit = val;
  }

  if (retryAfterRaw !== undefined) {
    const seconds = parseInt(retryAfterRaw, 10);
    if (!Number.isNaN(seconds)) {
      result.resetEpochMs = Date.now() + seconds * 1000;
    } else {
      const parsedDate = Date.parse(retryAfterRaw);
      if (!Number.isNaN(parsedDate)) {
        result.resetEpochMs = parsedDate;
      }
    }
  } else if (resetRaw !== undefined) {
    const val = parseInt(resetRaw, 10);
    if (!Number.isNaN(val)) {
      result.resetEpochMs = val < 1e11 ? val * 1000 : val;
    }
  }

  return result;
}

export class TokenPoolManager {
  private pools: Map<string, Map<string, TokenStatus>> = new Map();
  private roundRobinIndex: Map<string, number> = new Map();
  private queueOverride: Queue | null = null;
  private resumeTimers: Map<string, NodeJS.Timeout> = new Map();
  private pausedQueues: Set<string> = new Set();
  private initialized = false;

  constructor() {
    this.initFromEnv();
  }

  /**
   * Initialize platform token pools from environment configuration.
   */
  public initFromEnv(): void {
    if (env.GITHUB_TOKENS && env.GITHUB_TOKENS.length > 0) {
      this.registerTokens('github', env.GITHUB_TOKENS, 5000);
    } else if (env.GITHUB_TOKEN) {
      this.registerTokens('github', [env.GITHUB_TOKEN], 5000);
    }

    if (env.LEETCODE_TOKENS && env.LEETCODE_TOKENS.length > 0) {
      this.registerTokens('leetcode', env.LEETCODE_TOKENS, 1000);
    }

    this.initialized = true;
  }

  public init(): void {
    if (!this.initialized) {
      this.initFromEnv();
    }
  }

  /**
   * Register a list of tokens for a platform.
   */
  public registerTokens(platform: string, tokens: string[], defaultLimit = 5000): void {
    let pool = this.pools.get(platform);
    if (!pool) {
      pool = new Map();
      this.pools.set(platform, pool);
    }

    for (let i = 0; i < tokens.length; i++) {
      const trimmed = tokens[i].trim();
      if (!trimmed) continue;
      const id = hashToken(trimmed);
      if (!pool.has(id)) {
        pool.set(id, {
          id,
          platform,
          token: trimmed,
          remaining: defaultLimit,
          limit: defaultLimit,
          resetEpochMs: 0,
          inFlight: 0,
          lastUsedAt: 0,
        });
      }
    }
  }

  /**
   * Set custom queue instance (useful for unit tests and worker overrides).
   */
  public setQueue(queue: Queue | null): void {
    this.queueOverride = queue;
  }

  private getQueue(): Queue | undefined {
    if (this.queueOverride) return this.queueOverride;
    try {
      return getPlatformSyncQueue();
    } catch {
      return undefined;
    }
  }

  /**
   * Lease the token with the highest remaining quota using quota-weighted round-robin.
   */
  public async leaseToken(platform: string): Promise<LeasedToken | null> {
    const pool = this.pools.get(platform);
    if (!pool || pool.size === 0) {
      return null;
    }

    const now = Date.now();
    const tokenList = Array.from(pool.values());

    // Auto-restore expired reset locks
    tokenList.forEach((token) => {
      if (token.resetEpochMs > 0 && now >= token.resetEpochMs) {
        token.remaining = token.limit;
        token.resetEpochMs = 0;
      }
    });

    // Try distributed Redis sync if configured
    if (isRedisConfigured()) {
      try {
        const redis = getRedisClient();
        for (let i = 0; i < tokenList.length; i++) {
          const token = tokenList[i];
          const redisKey = `token_pool:${platform}:${token.id}`;
          const [remStr, resetStr, inFlightStr] = await redis.hmget(redisKey, 'remaining', 'resetEpochMs', 'inFlight');
          if (remStr !== null && remStr !== undefined) {
            token.remaining = parseInt(remStr, 10);
          }
          if (resetStr !== null && resetStr !== undefined) {
            token.resetEpochMs = parseInt(resetStr, 10);
          }
          if (inFlightStr !== null && inFlightStr !== undefined) {
            token.inFlight = parseInt(inFlightStr, 10);
          }
        }
      } catch (err) {
        logger.warn('[token-pool] Redis token sync failed, falling back to local pool', {
          platform,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Filter available candidates
    const available = tokenList.filter((t) => t.remaining > 0 && (t.resetEpochMs === 0 || now >= t.resetEpochMs));

    if (available.length === 0) {
      // All tokens exhausted
      const earliestReset = tokenList.reduce((min, t) => {
        if (t.resetEpochMs > now && (min === 0 || t.resetEpochMs < min)) {
          return t.resetEpochMs;
        }
        return min;
      }, 0);

      const effectiveReset = earliestReset > now ? earliestReset : now + 60000;
      await this.triggerQueueBackpressure(platform, effectiveReset);
      throw new QuotaExhaustedError(platform, effectiveReset);
    }

    // Quota-Weighted Round-Robin:
    // Sort primarily by remaining quota descending, secondarily by in-flight ascending, thirdly by lastUsedAt ascending
    available.sort((a, b) => {
      if (b.remaining !== a.remaining) {
        return b.remaining - a.remaining; // Higher remaining first
      }
      if (a.inFlight !== b.inFlight) {
        return a.inFlight - b.inFlight; // Fewer in-flight leases first
      }
      return a.lastUsedAt - b.lastUsedAt; // Least recently used first
    });

    // Round-robin selection among candidates within 90% of best remaining quota
    const bestQuota = available[0].remaining;
    const topCandidates = available.filter((t) => t.remaining >= bestQuota * 0.9);

    const rrIdx = (this.roundRobinIndex.get(platform) ?? 0) % topCandidates.length;
    this.roundRobinIndex.set(platform, rrIdx + 1);
    const selected = topCandidates[rrIdx];

    selected.inFlight += 1;
    selected.lastUsedAt = now;

    // Track in Redis if configured
    if (isRedisConfigured()) {
      try {
        const redis = getRedisClient();
        const redisKey = `token_pool:${platform}:${selected.id}`;
        await redis.hincrby(redisKey, 'inFlight', 1);
        await redis.hset(redisKey, 'lastUsedAt', now);
      } catch (err) {
        logger.debug('[token-pool] Redis inFlight increment error', { error: err });
      }
    }

    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      selected.inFlight = Math.max(0, selected.inFlight - 1);

      if (isRedisConfigured()) {
        try {
          const redis = getRedisClient();
          const redisKey = `token_pool:${platform}:${selected.id}`;
          const current = await redis.hincrby(redisKey, 'inFlight', -1);
          if (current < 0) {
            await redis.hset(redisKey, 'inFlight', 0);
          }
        } catch (err) {
          logger.debug('[token-pool] Redis inFlight decrement error', { error: err });
        }
      }
    };

    return {
      token: selected.token,
      id: selected.id,
      platform,
      release,
    };
  }

  /**
   * Update token quota metadata based on API response headers and status codes.
   */
  public async recordResponse(
    platform: string,
    token: string,
    headers: Headers | Record<string, string | string[] | undefined> | undefined,
    statusCode?: number
  ): Promise<void> {
    const pool = this.pools.get(platform);
    if (!pool) return;

    const id = hashToken(token);
    const entry = pool.get(id);
    if (!entry) return;

    const parsed = parseRateLimitHeaders(headers);
    const now = Date.now();

    if (statusCode === 429) {
      entry.remaining = 0;
      entry.resetEpochMs = parsed.resetEpochMs && parsed.resetEpochMs > now ? parsed.resetEpochMs : now + 60000;
    } else {
      if (parsed.remaining !== undefined) {
        entry.remaining = parsed.remaining;
      }
      if (parsed.limit !== undefined) {
        entry.limit = parsed.limit;
      }
      if (parsed.resetEpochMs !== undefined) {
        entry.resetEpochMs = parsed.resetEpochMs;
      }
    }

    // Persist to Redis if available
    if (isRedisConfigured()) {
      try {
        const redis = getRedisClient();
        const redisKey = `token_pool:${platform}:${id}`;
        await redis.hmset(redisKey, {
          remaining: entry.remaining,
          limit: entry.limit,
          resetEpochMs: entry.resetEpochMs,
          lastUsedAt: entry.lastUsedAt,
        });

        // Set TTL to expiration
        if (entry.resetEpochMs > now) {
          const ttlSec = Math.ceil((entry.resetEpochMs - now) / 1000) + 60;
          await redis.expire(redisKey, ttlSec);
        }
      } catch (err) {
        logger.debug('[token-pool] Redis quota record failed', { error: err });
      }
    }

    // Check if entire platform pool is exhausted
    const allExhausted = Array.from(pool.values()).every(
      (t) => t.remaining <= 0 || (t.resetEpochMs > now)
    );

    if (allExhausted) {
      const earliestReset = Array.from(pool.values()).reduce((min, t) => {
        if (t.resetEpochMs > now && (min === 0 || t.resetEpochMs < min)) {
          return t.resetEpochMs;
        }
        return min;
      }, 0);

      const effectiveReset = earliestReset > now ? earliestReset : now + 60000;
      await this.triggerQueueBackpressure(platform, effectiveReset);
    }
  }

  /**
   * Pause sync queue and schedule automated BullMQ delayed resume at token reset epoch.
   */
  public async triggerQueueBackpressure(platform: string, resetEpochMs: number): Promise<void> {
    const queue = this.getQueue();
    const now = Date.now();
    const delayMs = Math.max(100, resetEpochMs - now);

    logger.warn('[token-pool] Rate limit backpressure triggered', {
      event: 'sync_queue_backpressure',
      platform,
      resetEpochMs,
      delayMs,
      resumeAt: new Date(resetEpochMs).toISOString(),
    });

    if (queue && !this.pausedQueues.has(platform)) {
      try {
        await queue.pause();
        this.pausedQueues.add(platform);
        logger.info('[token-pool] Platform sync queue paused', {
          queue: QueueNames.PLATFORM_SYNC,
          platform,
        });
      } catch (err) {
        logger.error('[token-pool] Failed to pause platform sync queue', err);
      }
    }

    // Clear existing timer if any
    const existingTimer = this.resumeTimers.get(platform);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule delayed resumption
    const timer = setTimeout(async () => {
      await this.resumeQueue(platform);
    }, delayMs);

    // Unref timer so it doesn't prevent process exit
    if (timer.unref) {
      timer.unref();
    }

    this.resumeTimers.set(platform, timer);
  }

  /**
   * Resume paused queue for a platform.
   */
  public async resumeQueue(platform: string): Promise<void> {
    const queue = this.getQueue();
    const pool = this.pools.get(platform);

    // Reset quotas of expired tokens
    if (pool) {
      const now = Date.now();
      pool.forEach((token) => {
        if (token.resetEpochMs > 0 && now >= token.resetEpochMs) {
          token.remaining = token.limit;
          token.resetEpochMs = 0;
        }
      });
    }

    this.pausedQueues.delete(platform);
    const timer = this.resumeTimers.get(platform);
    if (timer) {
      clearTimeout(timer);
      this.resumeTimers.delete(platform);
    }

    if (queue) {
      try {
        await queue.resume();
        logger.info('[token-pool] Platform sync queue resumed', {
          queue: QueueNames.PLATFORM_SYNC,
          platform,
        });
      } catch (err) {
        logger.error('[token-pool] Failed to resume platform sync queue', err);
      }
    }
  }

  public isQueuePaused(platform: string): boolean {
    return this.pausedQueues.has(platform);
  }

  public getTokenStatuses(platform: string): TokenStatus[] {
    const pool = this.pools.get(platform);
    if (!pool) return [];
    return Array.from(pool.values()).map((t) => ({ ...t }));
  }

  /**
   * Clear all pools and timers (used in tests and shutdown).
   */
  public async close(): Promise<void> {
    this.resumeTimers.forEach((timer) => {
      clearTimeout(timer);
    });
    this.resumeTimers.clear();
    this.pausedQueues.clear();
  }

  public reset(): void {
    this.close();
    this.pools.clear();
    this.roundRobinIndex.clear();
    this.queueOverride = null;
    this.initialized = false;
  }
}

export const tokenPoolManager = new TokenPoolManager();
export default tokenPoolManager;
