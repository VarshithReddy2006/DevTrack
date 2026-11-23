// src/shared/search/searchLeaderLock.ts
// Redis-backed distributed leader lease with atomic ownership fencing.
// Coordinates single-leader execution of MongoDB Change Stream search synchronizers.

import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { getRedisClient } from '../redis/client.js';
import { logger } from '../logger.js';

export const DEFAULT_SEARCH_LEADER_LOCK_KEY = 'devtrack:lock:search_sync_leader';
export const DEFAULT_LEASE_TTL_MS = 10_000; // 10 seconds
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 3_000; // 3 seconds

// Atomic Lua Script: Renew lease TTL strictly if caller owns the current lease
export const RENEW_LEASE_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`.trim();

// Atomic Lua Script: Release lease strictly if caller owns the current lease
export const RELEASE_LEASE_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`.trim();

export interface LeaderLockOptions {
  lockKey?: string;
  ttlMs?: number;
  heartbeatMs?: number;
  ownerToken?: string;
  redisClient?: Redis;
}

export interface ILeaderLock {
  readonly lockKey: string;
  readonly ownerToken: string;
  readonly isHeld: boolean;

  acquire(): Promise<boolean>;
  renew(): Promise<boolean>;
  release(): Promise<boolean>;
  startHeartbeat(onLost?: () => void): void;
  stopHeartbeat(): void;
}

/**
 * Distributed leader lease backed by Redis with atomic ownership fencing.
 *
 * Fencing Semantics:
 * ------------------
 * 1. Acquisition: Uses atomic SET key token PX ttl NX. Exactly one worker wins the lease.
 * 2. Renewal: Uses Lua script. If the lease expired and was acquired by another worker,
 *    renewal fails (returns 0) and NEVER extends a successor's lease.
 * 3. Release: Uses Lua script. A delayed/stale worker NEVER deletes another worker's lease.
 *
 * Note on Downstream Fencing Limitations:
 * ---------------------------------------
 * This lease coordinates leader exclusivity within Redis. However, a distributed lock alone
 * cannot halt in-flight async operations already dispatched to downstream external services
 * (e.g. MeiliSearch/MongoDB) if a worker stalls beyond its lease TTL. Downstream writes
 * rely on monotonic document timestamps and idempotent upserts for end-to-end consistency.
 */
export class RedisLeaderLock implements ILeaderLock {
  public readonly lockKey: string;
  public readonly ttlMs: number;
  public readonly heartbeatMs: number;
  public readonly ownerToken: string;

  private redisClientOverride: Redis | null = null;
  private _isHeld = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: LeaderLockOptions = {}) {
    this.lockKey = options.lockKey || DEFAULT_SEARCH_LEADER_LOCK_KEY;
    this.ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_LEASE_TTL_MS;
    this.heartbeatMs = options.heartbeatMs && options.heartbeatMs > 0 ? options.heartbeatMs : DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.ownerToken = options.ownerToken || `${process.pid}-${crypto.randomUUID()}`;

    if (options.redisClient) {
      this.redisClientOverride = options.redisClient;
    }
  }

  public get isHeld(): boolean {
    return this._isHeld;
  }

  private getClient(): Redis {
    return this.redisClientOverride || getRedisClient();
  }

  /**
   * Attempts to acquire the distributed leader lease.
   * Atomic operation using SET NX PX.
   * Returns true if successfully acquired, false if lease is currently held by another worker.
   */
  public async acquire(): Promise<boolean> {
    const redis = this.getClient();

    try {
      const result = await redis.set(this.lockKey, this.ownerToken, 'PX', this.ttlMs, 'NX');
      const acquired = result === 'OK';

      this._isHeld = acquired;

      if (acquired) {
        logger.info('[searchLeaderLock] Lease acquired', {
          lockKey: this.lockKey,
          ownerToken: this.ownerToken,
          ttlMs: this.ttlMs,
        });
      }

      return acquired;
    } catch (err) {
      this._isHeld = false;
      logger.error('[searchLeaderLock] Error acquiring lease from Redis', err as Error, {
        lockKey: this.lockKey,
        ownerToken: this.ownerToken,
      });
      throw err;
    }
  }

  /**
   * Renews the distributed leader lease.
   * Atomically verifies that the stored ownerToken matches this instance's token before extending TTL.
   * Returns true if successfully renewed; false if ownership was lost or expired.
   */
  public async renew(): Promise<boolean> {
    const redis = this.getClient();

    try {
      // Execute atomic renewal Lua script
      const result = await redis.eval(
        RENEW_LEASE_LUA_SCRIPT,
        1,
        this.lockKey,
        this.ownerToken,
        this.ttlMs
      );

      // Lua returns 1 on success, 0 on mismatch / expired
      const renewed = Number(result) === 1;
      this._isHeld = renewed;

      if (!renewed) {
        logger.warn('[searchLeaderLock] Lease renewal failed; ownership lost or lease expired', {
          lockKey: this.lockKey,
          ownerToken: this.ownerToken,
        });
      }

      return renewed;
    } catch (err) {
      this._isHeld = false;
      logger.error('[searchLeaderLock] Error renewing lease in Redis', err as Error, {
        lockKey: this.lockKey,
        ownerToken: this.ownerToken,
      });
      throw err;
    }
  }

  /**
   * Releases the distributed leader lease.
   * Atomically verifies that the stored ownerToken matches this instance's token before deleting.
   * Returns true if successfully released; false if lock was not owned or already expired.
   */
  public async release(): Promise<boolean> {
    this.stopHeartbeat();
    const redis = this.getClient();

    try {
      // Execute atomic release Lua script
      const result = await redis.eval(
        RELEASE_LEASE_LUA_SCRIPT,
        1,
        this.lockKey,
        this.ownerToken
      );

      const released = Number(result) === 1;
      this._isHeld = false;

      if (released) {
        logger.info('[searchLeaderLock] Lease released cleanly', {
          lockKey: this.lockKey,
          ownerToken: this.ownerToken,
        });
      } else {
        logger.warn('[searchLeaderLock] Release failed or lock was already lost/expired', {
          lockKey: this.lockKey,
          ownerToken: this.ownerToken,
        });
      }

      return released;
    } catch (err) {
      this._isHeld = false;
      logger.error('[searchLeaderLock] Error releasing lease from Redis', err as Error, {
        lockKey: this.lockKey,
        ownerToken: this.ownerToken,
      });
      throw err;
    }
  }

  /**
   * Starts a background heartbeat timer that periodically renews the lease.
   * If renewal fails (lease lost/expired), stops the heartbeat and invokes the onLost callback.
   */
  public startHeartbeat(onLost?: () => void): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(async () => {
      try {
        const renewed = await this.renew();
        if (!renewed) {
          this.stopHeartbeat();
          onLost?.();
        }
      } catch (err) {
        logger.error('[searchLeaderLock] Heartbeat renewal exception; terminating heartbeat', err as Error, {
          lockKey: this.lockKey,
          ownerToken: this.ownerToken,
        });
        this.stopHeartbeat();
        onLost?.();
      }
    }, this.heartbeatMs);

    // Allow Node.js process to exit cleanly if only heartbeat timer is remaining
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * Stops the background heartbeat renewal timer.
   */
  public stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
