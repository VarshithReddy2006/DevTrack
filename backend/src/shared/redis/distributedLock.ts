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

export interface DistributedLockRetryOptions extends DistributedLockOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitter?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
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
  reason?: 'lock_held' | 'redis_unavailable' | 'redis_error' | 'timeout' | 'aborted';
}

export type DistributedLockUnavailableReason =
  | 'redis_not_ready'
  | 'redis_unavailable'
  | 'redis_error';

export type LockAcquireFailureReason =
  | 'lock_held'
  | 'redis_not_ready'
  | 'redis_error'
  | null;

/**
 * Typed error thrown when distributed lock acquisition fails closed because Redis
 * is disconnected, unavailable, or encountered an error during acquisition.
 */
export class DistributedLockUnavailableError extends Error {
  public readonly lockKey: string;
  public readonly reason: DistributedLockUnavailableReason;

  constructor(
    lockKey: string,
    reason: DistributedLockUnavailableReason,
    message?: string,
    cause?: unknown
  ) {
    super(
      message ||
        `Distributed lock unavailable for key "${lockKey}": ${reason}`,
      cause !== undefined ? { cause } : undefined
    );
    this.name = 'DistributedLockUnavailableError';
    this.lockKey = lockKey;
    this.reason = reason;
    Object.setPrototypeOf(this, DistributedLockUnavailableError.prototype);
  }
}

interface TestFallbackLockEntry {
  ownerToken: string;
  expiresAt: number;
}

// Single-process in-memory lock registry used strictly when NODE_ENV === 'test'
// and fallbackOnRedisUnavailable === true, preserving mutual exclusion in test suites.
const testFallbackLocks = new Map<string, TestFallbackLockEntry>();

function getLiveTestFallbackLock(lockKey: string): TestFallbackLockEntry | null {
  const entry = testFallbackLocks.get(lockKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    testFallbackLocks.delete(lockKey);
    return null;
  }
  return entry;
}

/**
 * Clears in-memory test-harness locks. No-op outside NODE_ENV === 'test'.
 */
export function clearTestFallbackLocks(): void {
  if (process.env.NODE_ENV === 'test') {
    testFallbackLocks.clear();
  }
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
  private _lastFailureReason: LockAcquireFailureReason = null;
  private _lastAcquireError: Error | null = null;

  constructor(nameOrKey: string, options: DistributedLockOptions = {}, fallbackMode = false) {
    this.lockKey = options.lockKey || formatJobLockKey(nameOrKey);
    this.ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_LOCK_TTL_MS;
    this.ownerToken = options.ownerToken || `${process.pid}-${crypto.randomUUID()}`;
    if (options.redisClient) {
      this.redisClientOverride = options.redisClient;
    }

    const isTestEnv = process.env.NODE_ENV === 'test';
    if (fallbackMode && !isTestEnv) {
      logger.warn('[distributedLock] Ignoring test-only fallbackMode outside NODE_ENV=test', {
        lockKey: this.lockKey,
        nodeEnv: process.env.NODE_ENV,
      });
    }
    this.fallbackMode = fallbackMode && isTestEnv;
  }

  public get isHeld(): boolean {
    return this._isHeld;
  }

  public get lastFailureReason(): LockAcquireFailureReason {
    return this._lastFailureReason;
  }

  public get lastAcquireError(): Error | null {
    return this._lastAcquireError;
  }

  private getClient(): Redis {
    return this.redisClientOverride || getRedisClient();
  }

  /**
   * Attempts to acquire the distributed lock atomically via SET NX PX.
   */
  public async acquire(): Promise<boolean> {
    this._isHeld = false;
    this._lastFailureReason = null;
    this._lastAcquireError = null;

    if (this.fallbackMode) {
      if (process.env.NODE_ENV !== 'test') {
        this._lastFailureReason = 'redis_not_ready';
        return false;
      }
      const existing = getLiveTestFallbackLock(this.lockKey);
      if (existing) {
        this._lastFailureReason = 'lock_held';
        return false;
      }
      testFallbackLocks.set(this.lockKey, {
        ownerToken: this.ownerToken,
        expiresAt: Date.now() + this.ttlMs,
      });
      this._isHeld = true;
      return true;
    }

    const redis = this.getClient();
    if (!redis || redis.status !== 'ready' || typeof redis.set !== 'function') {
      logger.warn('[distributedLock] Redis not ready or unavailable for lock acquisition', {
        lockKey: this.lockKey,
        status: redis?.status,
      });
      this._lastFailureReason = 'redis_not_ready';
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
        this._lastFailureReason = 'lock_held';
        logger.info('[distributedLock] Lock acquisition skipped (already held)', {
          lockKey: this.lockKey,
          ttlMs: this.ttlMs,
        });
      }

      return acquired;
    } catch (err) {
      const normalizedError = err instanceof Error ? err : new Error(String(err));
      logger.error('[distributedLock] Failed to acquire lock due to Redis error', normalizedError, {
        lockKey: this.lockKey,
        error: normalizedError.message,
      });
      this._isHeld = false;
      this._lastFailureReason = 'redis_error';
      this._lastAcquireError = normalizedError;
      return false;
    }
  }

  /**
   * Releases the lock atomically using a Lua script to ensure ownership token matches.
   */
  public async release(): Promise<boolean> {
    this.stopAutoRenew();

    if (!this._isHeld) {
      return false;
    }

    if (this.fallbackMode) {
      const existing = getLiveTestFallbackLock(this.lockKey);
      const released = Boolean(existing && existing.ownerToken === this.ownerToken);
      if (released) {
        testFallbackLocks.delete(this.lockKey);
      }
      this._isHeld = false;
      return released;
    }

    const redis = this.getClient();
    if (!redis || redis.status !== 'ready' || typeof redis.eval !== 'function') {
      logger.warn('[distributedLock] Redis not ready or unavailable during lock release', {
        lockKey: this.lockKey,
        status: redis?.status,
      });
      this._isHeld = false;
      return false;
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
    if (!this._isHeld) {
      return false;
    }

    const newTtl = additionalTtlMs && additionalTtlMs > 0 ? additionalTtlMs : this.ttlMs;

    if (this.fallbackMode) {
      if (process.env.NODE_ENV !== 'test') {
        this._isHeld = false;
        this.stopAutoRenew();
        return false;
      }
      const existing = getLiveTestFallbackLock(this.lockKey);
      if (!existing || existing.ownerToken !== this.ownerToken) {
        this._isHeld = false;
        this.stopAutoRenew();
        return false;
      }
      existing.expiresAt = Date.now() + newTtl;
      return true;
    }

    const redis = this.getClient();
    if (!redis || redis.status !== 'ready' || typeof redis.eval !== 'function') {
      this._isHeld = false;
      this.stopAutoRenew();
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
      this._isHeld = false;
      this.stopAutoRenew();
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
      if (!this._isHeld) {
        this.stopAutoRenew();
        return;
      }
      try {
        const extended = await this.extend();
        if (!extended) {
          this.stopAutoRenew();
        }
      } catch {
        this._isHeld = false;
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
 * Attempts to acquire a distributed lock.
 * Fails closed by throwing DistributedLockUnavailableError when Redis is unavailable or errors.
 * Returns a DistributedLockHandle if acquired, or null if held by another instance.
 */
export async function acquireDistributedLock(
  jobNameOrKey: string,
  options: DistributedLockOptions = {}
): Promise<DistributedLockHandle | null> {
  const isTestEnv = process.env.NODE_ENV === 'test';
  const allowTestFallback = isTestEnv && options.fallbackOnRedisUnavailable === true;
  const redis = options.redisClient || getRedisClient();
  const lockKey = options.lockKey || formatJobLockKey(jobNameOrKey);

  if (!isTestEnv && options.fallbackOnRedisUnavailable === true) {
    logger.warn('[distributedLock] Ignoring fallbackOnRedisUnavailable outside NODE_ENV=test; failing closed', {
      job: jobNameOrKey,
      lockKey,
      nodeEnv: process.env.NODE_ENV,
    });
  }

  if (!redis || redis.status !== 'ready' || typeof redis.set !== 'function') {
    if (allowTestFallback) {
      logger.warn('[distributedLock] TEST HARNESS ONLY: Redis not ready, using in-memory test lock', {
        job: jobNameOrKey,
        lockKey,
        status: redis?.status,
      });
      const testLock = new DistributedLock(jobNameOrKey, options, true);
      const acquired = await testLock.acquire();
      if (!acquired) {
        return null;
      }
      if (options.autoRenew) {
        testLock.startAutoRenew(options.renewIntervalMs);
      }
      return testLock;
    }

    throw new DistributedLockUnavailableError(
      lockKey,
      'redis_not_ready',
      `Cannot acquire distributed lock "${lockKey}": Redis client is not ready (status: ${redis?.status ?? 'undefined'})`
    );
  }

  const lock = new DistributedLock(jobNameOrKey, options, false);
  const acquired = await lock.acquire();
  if (!acquired) {
    if (lock.lastFailureReason === 'redis_not_ready' || lock.lastFailureReason === 'redis_error') {
      throw new DistributedLockUnavailableError(
        lockKey,
        lock.lastFailureReason,
        `Cannot acquire distributed lock "${lockKey}": ${lock.lastAcquireError?.message || lock.lastFailureReason}`,
        lock.lastAcquireError ?? undefined
      );
    }
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

const DEFAULT_RETRY_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_RETRY_BACKOFF_FACTOR = 1.5;
const DEFAULT_RETRY_JITTER_MS = 25;

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function normalizeRetryOptions(
  ttlMsOrOptions?: number | DistributedLockRetryOptions,
  maybeOptions?: DistributedLockRetryOptions
): DistributedLockRetryOptions {
  if (typeof ttlMsOrOptions === 'number') {
    return { ...maybeOptions, ttlMs: ttlMsOrOptions };
  }
  return { ...(ttlMsOrOptions ?? maybeOptions ?? {}) };
}

/**
 * Attempts to acquire a distributed lock with exponential backoff, randomized jitter,
 * overall timeout enforcement, and AbortSignal cancellation.
 */
export async function acquireWithRetry(
  jobNameOrKey: string,
  ttlMsOrOptions?: number | DistributedLockRetryOptions,
  maybeOptions?: DistributedLockRetryOptions
): Promise<DistributedLockHandle | null> {
  const options = normalizeRetryOptions(ttlMsOrOptions, maybeOptions);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const maxDelayMs = Math.max(retryDelayMs, options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS);
  const backoffFactor =
    options.backoffFactor !== undefined && options.backoffFactor > 0
      ? options.backoffFactor
      : DEFAULT_RETRY_BACKOFF_FACTOR;
  const jitter = Math.max(0, options.jitter ?? DEFAULT_RETRY_JITTER_MS);
  const timeoutMs =
    options.timeoutMs !== undefined && options.timeoutMs >= 0 ? options.timeoutMs : undefined;
  const abortSignal = options.abortSignal;

  if (abortSignal?.aborted) {
    return null;
  }

  const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : Infinity;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (abortSignal?.aborted || Date.now() >= deadline) {
      return null;
    }

    const lock = await acquireDistributedLock(jobNameOrKey, options);
    if (lock) {
      if (abortSignal?.aborted) {
        await lock.release().catch(() => false);
        return null;
      }
      return lock;
    }

    if (attempt === maxAttempts - 1) {
      break;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }

    const backoffMs = Math.min(maxDelayMs, retryDelayMs * (backoffFactor ** attempt));
    const sleepMs = backoffMs + Math.random() * jitter;
    const waitMs = Number.isFinite(remainingMs) ? Math.min(sleepMs, remainingMs) : sleepMs;

    const completed = await sleepWithAbort(waitMs, abortSignal);
    if (!completed || Date.now() >= deadline) {
      return null;
    }
  }

  return null;
}

async function executeWithLockHandle<T>(
  jobNameOrKey: string,
  lock: DistributedLockHandle,
  task: (lock: DistributedLockHandle) => Promise<T>
): Promise<DistributedLockResult<T>> {
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

/**
 * High-level wrapper executing a task with distributed lock protection.
 * Fails closed when Redis is unavailable or lock acquisition errors, and skips when lock is held.
 * Safely releases the lock in a finally block regardless of task success or error.
 */
export async function withDistributedLock<T>(
  jobNameOrKey: string,
  task: (lock: DistributedLockHandle) => Promise<T>,
  options: DistributedLockOptions = {}
): Promise<DistributedLockResult<T>> {
  const lockKey = options.lockKey || formatJobLockKey(jobNameOrKey);
  let lock: DistributedLockHandle | null = null;

  try {
    lock = await acquireDistributedLock(jobNameOrKey, options);
  } catch (err) {
    if (err instanceof DistributedLockUnavailableError) {
      const mappedReason: DistributedLockResult<T>['reason'] =
        err.reason === 'redis_error' ? 'redis_error' : 'redis_unavailable';
      logger.warn('[distributedLock] Skipping job execution: distributed lock unavailable', {
        job: jobNameOrKey,
        lockKey,
        reason: err.reason,
        error: err.message,
      });
      return { executed: false, reason: mappedReason };
    }

    logger.error('[distributedLock] Unexpected error acquiring distributed lock', err as Error, {
      job: jobNameOrKey,
      lockKey,
    });
    return { executed: false, reason: 'redis_error' };
  }

  if (!lock) {
    logger.info('[distributedLock] Skipping overlapping job execution: lock held by another instance', {
      job: jobNameOrKey,
      lockKey,
    });
    return { executed: false, reason: 'lock_held' };
  }

  return executeWithLockHandle(jobNameOrKey, lock, task);
}

/**
 * High-level wrapper executing a task with distributed lock retry protection.
 * Uses exponential backoff with jitter, timeoutMs, and optional AbortSignal.
 */
export async function withDistributedLockRetry<T>(
  jobNameOrKey: string,
  task: (lock: DistributedLockHandle) => Promise<T>,
  options: DistributedLockRetryOptions = {}
): Promise<DistributedLockResult<T>> {
  const startMs = Date.now();
  const lock = await acquireWithRetry(jobNameOrKey, options);
  if (!lock) {
    let reason: DistributedLockResult<T>['reason'] = 'lock_held';
    if (options.abortSignal?.aborted) {
      reason = 'aborted';
    } else if (options.timeoutMs !== undefined && Date.now() - startMs >= options.timeoutMs) {
      reason = 'timeout';
    }

    logger.info('[distributedLock] Skipping job execution after retries: lock not acquired', {
      job: jobNameOrKey,
      lockKey: options.lockKey || formatJobLockKey(jobNameOrKey),
      reason,
    });
    return { executed: false, reason };
  }

  return executeWithLockHandle(jobNameOrKey, lock, task);
}
