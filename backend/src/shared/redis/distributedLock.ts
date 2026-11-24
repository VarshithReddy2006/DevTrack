// src/shared/redis/distributedLock.ts
// Redis-backed distributed lock with atomic ownership fencing.
// Prevents overlapping execution of scheduled tasks and background jobs across replicas.

import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { getRedisClient } from './client.js';
import { logger } from '../logger.js';

export const DEFAULT_LOCK_TTL_MS = 60_000; // 60 seconds
export const DEFAULT_LOCK_PREFIX = 'devtrack:lock:job:';

// Atomic Lua Script: Release lock strictly if caller owns the current lock token
export const RELEASE_LOCK_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`.trim();

// Atomic Lua Script: Extend lock TTL strictly if caller owns the current lock token
export const EXTEND_LOCK_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`.trim();

export interface DistributedLockOptions {
  ttlMs?: number;
  lockKey?: string;
  ownerToken?: string;
  redisClient?: Redis;
  autoRenew?: boolean;
  renewIntervalMs?: number;
  fallbackOnRedisUnavailable?: boolean;
}

export interface DistributedLockHandle {
  readonly lockKey: string;
  readonly ownerToken: string;
  readonly ttlMs: number;
  readonly isHeld: boolean;
  release(): Promise<boolean>;
  extend(additionalTtlMs?: number): Promise<boolean>;
  startAutoRenew(intervalMs?: number): void;
  stopAutoRenew(): void;
}

export interface DistributedLockResult<T> {
  executed: boolean;
  result?: T;
  reason?: 'lock_held' | 'redis_unavailable' | 'redis_error';
}

/**
 * Formats a standardized Redis key for a scheduled job lock.
 */
export function formatJobLockKey(nameOrKey: string): string {
  if (
    nameOrKey.startsWith('devtrack:') ||
    nameOrKey.startsWith('sse:') ||
    nameOrKey.startsWith('missions:')
  ) {
    return nameOrKey;
  }
  return `${DEFAULT_LOCK_PREFIX}${nameOrKey}`;
}

/**
 * Distributed Lock instance coordinating mutual exclusion in Redis with owner fencing.
 */
export class DistributedLock implements DistributedLockHandle {
  public readonly lockKey: string;
  public readonly ttlMs: number;
  public readonly ownerToken: string;
  private redisClientOverride: Redis | null = null;
  private _isHeld = false;
  private autoRenewTimer: NodeJS.Timeout | null = null;
  private fallbackMode = false;

  constructor(nameOrKey: string, options: DistributedLockOptions = {}, fallbackMode = false) {
    this.lockKey = options.lockKey || formatJobLockKey(nameOrKey);
    this.ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_LOCK_TTL_MS;
    this.ownerToken = options.ownerToken || `${process.pid}-${crypto.randomUUID()}`;
    if (options.redisClient) {
      this.redisClientOverride = options.redisClient;
    }
    this.fallbackMode = fallbackMode;
    if (fallbackMode) {
      this._isHeld = true;
    }
  }

  public get isHeld(): boolean {
    return this._isHeld;
  }

  private getClient(): Redis {
    return this.redisClientOverride || getRedisClient();
  }

  /**
   * Attempts to acquire the distributed lock atomically via SET NX PX.
   */
  public async acquire(): Promise<boolean> {
    if (this.fallbackMode) {
      this._isHeld = true;
      return true;
    }

    const redis = this.getClient();
    if (!redis || redis.status !== 'ready' || typeof redis.set !== 'function') {
      logger.warn('[distributedLock] Redis not ready or unavailable for lock acquisition', {
        lockKey: this.lockKey,
        status: redis?.status,
      });
      return false;
    }

    try {
      const result = await redis.set(this.lockKey, this.ownerToken, 'PX', this.ttlMs, 'NX');
      const acquired = result === 'OK';
      this._isHeld = acquired;

      if (acquired) {
        logger.debug('[distributedLock] Lock acquired', {
          lockKey: this.lockKey,
          ownerToken: this.ownerToken,
          ttlMs: this.ttlMs,
        });
      } else {
        logger.info('[distributedLock] Lock acquisition skipped (already held)', {
          lockKey: this.lockKey,
          ttlMs: this.ttlMs,
        });
      }

      return acquired;
    } catch (err) {
      logger.error('[distributedLock] Failed to acquire lock due to Redis error', err as Error, {
        lockKey: this.lockKey,
        error: err instanceof Error ? err.message : String(err),
      });
      this._isHeld = false;
      return false;
    }
  }

  /**
   * Releases the lock atomically using a Lua script to ensure ownership token matches.
   */
  public async release(): Promise<boolean> {
    this.stopAutoRenew();

    if (this.fallbackMode) {
      this._isHeld = false;
      return true;
    }

    if (!this._isHeld) {
      return false;
    }

    const redis = this.getClient();
    if (!redis || redis.status !== 'ready' || typeof redis.eval !== 'function') {
      logger.warn('[distributedLock] Redis not ready or unavailable during lock release', {
        lockKey: this.lockKey,
        status: redis?.status,
      });
      this._isHeld = false;
      return true; // Graceful degradation
    }

    try {
      const result = await redis.eval(RELEASE_LOCK_LUA_SCRIPT, 1, this.lockKey, this.ownerToken);
      const released = result === 1;
      this._isHeld = false;

      if (released) {
        logger.debug('[distributedLock] Lock released safely', {
          lockKey: this.lockKey,
          ownerToken: this.ownerToken,
        });
      } else {
        logger.warn('[distributedLock] Lock release returned 0 (lock lost or owned by another worker)', {
          lockKey: this.lockKey,
          ownerToken: this.ownerToken,
        });
      }

      return released;
    } catch (err) {
      logger.error('[distributedLock] Failed to release lock due to Redis error', err as Error, {
        lockKey: this.lockKey,
        error: err instanceof Error ? err.message : String(err),
      });
      this._isHeld = false;
      return false;
    }
  }

  /**
   * Extends the lock TTL atomically using a Lua script to verify ownership token.
   */
  public async extend(additionalTtlMs?: number): Promise<boolean> {
    if (this.fallbackMode) {
      return true;
    }

    const newTtl = additionalTtlMs && additionalTtlMs > 0 ? additionalTtlMs : this.ttlMs;
    const redis = this.getClient();
    if (!redis || redis.status !== 'ready' || typeof redis.eval !== 'function') {
      return false;
    }

    try {
      const result = await redis.eval(EXTEND_LOCK_LUA_SCRIPT, 1, this.lockKey, this.ownerToken, newTtl);
      const extended = result === 1;
      if (!extended) {
        this._isHeld = false;
        this.stopAutoRenew();
      }
      return extended;
    } catch (err) {
      logger.error('[distributedLock] Failed to extend lock TTL', err as Error, {
        lockKey: this.lockKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Starts periodic heartbeat to extend lock TTL while long-running jobs are executing.
   */
  public startAutoRenew(intervalMs?: number): void {
    if (this.autoRenewTimer || !this._isHeld) return;
    const interval =
      intervalMs && intervalMs > 0 ? intervalMs : Math.max(1000, Math.floor(this.ttlMs / 3));

    this.autoRenewTimer = setInterval(async () => {
      const extended = await this.extend();
      if (!extended) {
        this.stopAutoRenew();
      }
    }, interval);

    if (this.autoRenewTimer.unref) {
      this.autoRenewTimer.unref();
    }
  }

  /**
   * Stops the auto-renewal timer.
   */
  public stopAutoRenew(): void {
    if (this.autoRenewTimer) {
      clearInterval(this.autoRenewTimer);
      this.autoRenewTimer = null;
    }
  }
}

/**
 * Attempts to acquire a distributed lock. Returns a DistributedLockHandle if acquired, or null if held.
 */
export async function acquireDistributedLock(
  jobNameOrKey: string,
  options: DistributedLockOptions = {}
): Promise<DistributedLockHandle | null> {
  const fallback =
    options.fallbackOnRedisUnavailable ?? (process.env.NODE_ENV === 'test');
  const redis = options.redisClient || getRedisClient();

  if (!redis || redis.status !== 'ready' || typeof redis.set !== 'function') {
    if (fallback) {
      logger.warn('[distributedLock] Redis not ready, proceeding with fallback lock', {
        job: jobNameOrKey,
        status: redis?.status,
      });
      return new DistributedLock(jobNameOrKey, options, true);
    }
    return null;
  }

  const lock = new DistributedLock(jobNameOrKey, options, false);
  const acquired = await lock.acquire();
  if (!acquired) {
    return null;
  }

  if (options.autoRenew) {
    lock.startAutoRenew(options.renewIntervalMs);
  }

  return lock;
}

/**
 * Releases a distributed lock handle.
 */
export async function releaseDistributedLock(handle: DistributedLockHandle): Promise<boolean> {
  return handle.release();
}

/**
 * Extends a distributed lock handle.
 */
export async function extendDistributedLock(
  handle: DistributedLockHandle,
  additionalTtlMs?: number
): Promise<boolean> {
  return handle.extend(additionalTtlMs);
}

/**
 * High-level wrapper executing a task with distributed lock protection.
 * Skips execution and logs when the lock is already held.
 * Safely releases the lock in a finally block regardless of task success or error.
 */
export async function withDistributedLock<T>(
  jobNameOrKey: string,
  task: (lock: DistributedLockHandle) => Promise<T>,
  options: DistributedLockOptions = {}
): Promise<DistributedLockResult<T>> {
  const lock = await acquireDistributedLock(jobNameOrKey, options);
  if (!lock) {
    logger.info('[distributedLock] Skipping overlapping job execution: lock held by another instance', {
      job: jobNameOrKey,
      lockKey: options.lockKey || formatJobLockKey(jobNameOrKey),
    });
    return { executed: false, reason: 'lock_held' };
  }

  try {
    const result = await task(lock);
    return { executed: true, result };
  } finally {
    try {
      await lock.release();
    } catch (releaseErr) {
      logger.warn('[distributedLock] Error releasing lock in finally block', {
        job: jobNameOrKey,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
  }
}
