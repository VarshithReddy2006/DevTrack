// src/shared/redis/syncLock.service.ts
// Distributed mutex for platform sync operations using Redis SETNX
// Prevents concurrent syncs for same (userId, platform) pair

import { getRedisClient } from './client.js';
import { logger } from '../logger.js';
import { trackSyncLockAcquisition, trackSyncLockFailure, trackSyncLockRelease, trackStaleLocksCleaned } from '../monitoring.js';

const LOCK_TIMEOUT_MS = 30_000; // 30 second lock timeout
const LOCK_RETRY_DELAY_MS = 500; // 500ms between retry attempts
const MAX_LOCK_RETRIES = 10; // Max 5 seconds total wait

const SCHEDULER_LOCK_KEY = 'sse:sync:scheduler:leader';
const SCHEDULER_LOCK_TIMEOUT_MS = 60_000; // 60s TTL for scheduler sweep

/**
 * Attempts to acquire the distributed scheduler leader lock.
 * Ensures only one replica executes the scheduled sync sweep.
 */
export async function acquireSchedulerLock(ttlMs: number = SCHEDULER_LOCK_TIMEOUT_MS): Promise<boolean> {
  const redis = getRedisClient();
  if (redis.status !== 'ready') {
    return true; // Graceful degradation in non-redis test envs
  }
  try {
    const result = await redis.set(SCHEDULER_LOCK_KEY, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.warn('[syncLock] Error acquiring scheduler lock', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Releases the distributed scheduler leader lock.
 */
export async function releaseSchedulerLock(): Promise<boolean> {
  const redis = getRedisClient();
  if (redis.status !== 'ready') return true;
  try {
    const deleted = await redis.del(SCHEDULER_LOCK_KEY);
    return deleted > 0;
  } catch (err) {
    logger.warn('[syncLock] Error releasing scheduler lock', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Generates a unique lock key for a user-platform pair
 */
function getLockKey(userId: string, platform: string): string {
  return `sse:sync:lock:${userId}:${platform}`;
}

/**
 * Attempts to acquire a distributed sync lock for a specific user-platform pair.
 * Uses Redis SETNX (SET if Not eXists) with expiration.
 * 
 * @param userId User ID
 * @param platform Platform name (leetcode, codeforces, etc)
 * @returns true if lock acquired, false if already locked
 * @throws On Redis errors
 */
export async function acquireSyncLock(userId: string, platform: string): Promise<boolean> {
  const redis = getRedisClient();
  const lockKey = getLockKey(userId, platform);

  if (redis.status !== 'ready') {
    logger.warn('[syncLock] Redis not ready, allowing sync without lock', {
      userId,
      platform,
      redisStatus: redis.status,
    });
    return true; // Graceful degradation
  }

  try {
    // Atomic SET with NX (Not Exists) and PX (Milliseconds Expiry)
    // This prevents orphaned locks if the process crashes between SETNX and EXPIRE
    const result = await redis.set(
      lockKey,
      '1',
      'PX',
      LOCK_TIMEOUT_MS,
      'NX'
    );

    const acquired = result === 'OK';

    if (acquired) {
      logger.info('[syncLock] Lock acquired', {
        event: 'sync_lock_acquired',
        userId,
        platform,
        timeoutMs: LOCK_TIMEOUT_MS,
      });
      trackSyncLockAcquisition(userId, platform);
    }

    return acquired;
  } catch (err) {
    logger.error('[syncLock] Failed to acquire lock', err as Error, {
      userId,
      platform,
      error: err instanceof Error ? err.message : String(err),
    });
    trackSyncLockFailure(userId, platform);
    throw err;
  }
}

/**
 * Releases a sync lock. Safe to call even if lock not held.
 * 
 * @param userId User ID
 * @param platform Platform name
 * @returns true if lock existed and was deleted, false if lock not found
 */
export async function releaseSyncLock(userId: string, platform: string): Promise<boolean> {
  const redis = getRedisClient();
  const lockKey = getLockKey(userId, platform);

  if (redis.status !== 'ready') {
    logger.warn('[syncLock] Redis not ready, skip lock release', {
      userId,
      platform,
    });
    return true; // Graceful degradation
  }

  try {
    const deleted = await redis.del(lockKey);
    const released = deleted > 0;

    if (released) {
      logger.info('[syncLock] Lock released', {
        event: 'sync_lock_released',
        userId,
        platform,
      });
      trackSyncLockRelease(userId, platform);
    }

    return released;
  } catch (err) {
    logger.error('[syncLock] Failed to release lock', err as Error, {
      userId,
      platform,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Checks if a sync lock is currently held without acquiring it
 * 
 * @param userId User ID
 * @param platform Platform name
 * @returns true if lock exists (sync in progress), false otherwise
 */
export async function isSyncLocked(userId: string, platform: string): Promise<boolean> {
  const redis = getRedisClient();
  const lockKey = getLockKey(userId, platform);

  if (redis.status !== 'ready') {
    return false; // Can't check if Redis down, assume not locked
  }

  try {
    const exists = await redis.exists(lockKey);
    return exists > 0;
  } catch (err) {
    logger.warn('[syncLock] Failed to check lock status', {
      userId,
      platform,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Acquires a sync lock with automatic retries and backoff.
 * Waits up to MAX_LOCK_RETRIES * LOCK_RETRY_DELAY_MS before giving up.
 * 
 * @param userId User ID
 * @param platform Platform name
 * @param maxRetries Number of retry attempts (default: MAX_LOCK_RETRIES)
 * @returns true if lock acquired, false if timeout
 */
export async function acquireSyncLockWithRetry(
  userId: string,
  platform: string,
  maxRetries: number = MAX_LOCK_RETRIES
): Promise<boolean> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const acquired = await acquireSyncLock(userId, platform);
      if (acquired) {
        return true;
      }

      // Lock held by another sync, wait and retry
      if (attempt < maxRetries) {
        const delayMs = LOCK_RETRY_DELAY_MS * attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        logger.info('[syncLock] Retry acquiring lock', {
          userId,
          platform,
          attempt,
          nextDelayMs: delayMs * 2,
        });
      }
    } catch (err) {
      lastError = err as Error;
      logger.warn('[syncLock] Error during retry, continuing', {
        userId,
        platform,
        attempt,
        error: lastError.message,
      });
    }
  }

  logger.warn('[syncLock] Failed to acquire lock after retries', {
    event: 'sync_lock_timeout',
    userId,
    platform,
    maxRetries,
    totalWaitMs: LOCK_RETRY_DELAY_MS * (maxRetries * (maxRetries + 1)) / 2,
    lastError: lastError?.message,
  });

  return false;
}

/**
 * Cleans up stale locks (age > timeout)
 * Called by maintenance worker to recover from hung syncs
 * 
 * @returns Count of stale locks deleted
 */
export async function cleanupStaleLocks(): Promise<number> {
  const redis = getRedisClient();

  if (redis.status !== 'ready') {
    return 0;
  }

  try {
    // Find all sync lock keys
    const locks = await redis.keys('sse:sync:lock:*');
    
    if (locks.length === 0) {
      return 0;
    }

    // For each lock, check if it has auto-expired (TTL > 0)
    // If TTL is -1 (no expiry) or close to timeout, we need to investigate
    // This shouldn't happen with our SETNX + EX, but fallback cleanup
    const staleCount = await Promise.all(
      locks.map(async (key) => {
        try {
          const ttl = await redis.ttl(key);
          
          // TTL -1 means key exists but has no expiry (shouldn't happen)
          // If found, this indicates a lock that didn't expire properly
          if (ttl === -1) {
            logger.warn('[syncLock] Found lock with no expiry, deleting', {
              lockKey: key,
            });
            await redis.del(key);
            return 1;
          }

          return 0;
        } catch (err) {
          logger.warn('[syncLock] Error checking lock TTL', {
            lockKey: key,
            error: err instanceof Error ? err.message : String(err),
          });
          return 0;
        }
      })
    );

    const deleted = staleCount.reduce((sum: number, count: number) => sum + count, 0);

    if (deleted > 0) {
      logger.info('[syncLock] Cleanup completed', {
        event: 'sync_lock_cleanup',
        staleLocksCleaned: deleted,
        totalLocks: locks.length,
      });
      trackStaleLocksCleaned(deleted);
    }

    return deleted;
  } catch (err) {
    logger.error('[syncLock] Cleanup failed', err as Error, {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
