// src/shared/search/searchResumeToken.ts
// Durable Redis-backed store for MongoDB Change Stream resume tokens.
// Preserves opaque oplog checkpoints across process restarts and worker failovers.

import type Redis from 'ioredis';
import { getRedisClient } from '../redis/client.js';
import { logger } from '../logger.js';

export const RESUME_TOKEN_KEY_PREFIX = 'devtrack:search:resume_token:';

export interface CheckpointFencingOptions {
  lockKey: string;
  ownerToken: string;
}

export class FencedCheckpointError extends Error {
  constructor(message: string, public readonly lockKey: string, public readonly ownerToken: string) {
    super(message);
    this.name = 'FencedCheckpointError';
  }
}

// Atomic Lua Script: Persist resume token checkpoint strictly if the caller owns the leader lease
export const FENCED_CHECKPOINT_LUA_SCRIPT = `
local currentOwner = redis.call("get", KEYS[1])
if currentOwner == ARGV[1] then
  redis.call("set", KEYS[2], ARGV[2])
  return 1
else
  return 0
end
`.trim();

/**
 * Returns the canonical Redis key for persisting the change stream resume token
 * for a specific MongoDB collection.
 */
export function getResumeTokenKey(collectionName: string): string {
  const sanitized = collectionName.trim().toLowerCase();
  if (!sanitized) {
    throw new Error('collectionName cannot be empty when resolving resume token key');
  }
  return `${RESUME_TOKEN_KEY_PREFIX}${sanitized}`;
}

export interface PersistedResumeToken<T = unknown> {
  token: T;
  collection: string;
  updatedAt: number;
}

export interface IResumeTokenStore {
  getResumeToken<T = unknown>(collectionName: string): Promise<T | null>;
  saveResumeToken(collectionName: string, token: unknown, fencing?: CheckpointFencingOptions): Promise<void>;
  clearResumeToken(collectionName: string): Promise<void>;
}

/**
 * Redis-backed implementation of IResumeTokenStore.
 *
 * Checkpoint Safety Invariant:
 * ----------------------------
 * A resume token must ONLY be persisted to Redis *after* the corresponding batch
 * of changes has been processed and successfully acknowledged by the search provider.
 * Advancing the token before search indexing acknowledgement risks permanent silent data loss on crashes.
 * Advancing after acknowledgement is crash-safe due to idempotent upserts.
 */
export class RedisResumeTokenStore implements IResumeTokenStore {
  private redisClientOverride: Redis | null = null;

  constructor(client?: Redis) {
    if (client) {
      this.redisClientOverride = client;
    }
  }

  /**
   * Internal helper resolving the active Redis connection.
   */
  private getClient(): Redis {
    return this.redisClientOverride || getRedisClient();
  }

  /**
   * Sets or clears the test Redis client override.
   */
  public setClientForTesting(client: Redis | null): void {
    this.redisClientOverride = client;
  }

  /**
   * Retrieves the persisted resume token for a collection.
   * Returns null if no checkpoint exists or if the stored value is malformed.
   */
  public async getResumeToken<T = unknown>(collectionName: string): Promise<T | null> {
    const key = getResumeTokenKey(collectionName);
    const redis = this.getClient();

    try {
      const raw = await redis.get(key);
      if (!raw) {
        return null;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        logger.warn('[searchResumeToken] Malformed JSON in resume token store; discarding corrupted checkpoint', {
          key,
          raw,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
        return null;
      }

      if (!parsed || typeof parsed !== 'object') {
        logger.warn('[searchResumeToken] Invalid resume token format (not an object); discarding', { key, raw });
        return null;
      }

      const payload = parsed as Record<string, unknown>;
      if (!('token' in payload) || payload.token === undefined || payload.token === null) {
        logger.warn('[searchResumeToken] Missing token property in checkpoint payload', { key, raw });
        return null;
      }

      return payload.token as T;
    } catch (err) {
      logger.error('[searchResumeToken] Failed to read resume token from Redis', err as Error, {
        key,
        collectionName,
      });
      throw err;
    }
  }

  /**
   * Persists an opaque MongoDB resume token for a collection.
   *
   * Note on Token Semantics:
   * The token is treated as completely opaque. It is never inspected, mutated, or manufactured.
   *
   * Checkpoint Fencing:
   * If fencing options are provided (lockKey and ownerToken), the write is executed atomically
   * via Lua script, verifying the caller still owns the leader lease before updating Redis.
   */
  public async saveResumeToken(
    collectionName: string,
    token: unknown,
    fencing?: CheckpointFencingOptions
  ): Promise<void> {
    if (token === undefined || token === null) {
      throw new Error(`Cannot persist undefined or null resume token for collection "${collectionName}"`);
    }

    const key = getResumeTokenKey(collectionName);
    const redis = this.getClient();

    const payload: PersistedResumeToken = {
      token,
      collection: collectionName.trim().toLowerCase(),
      updatedAt: Date.now(),
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (serErr) {
      logger.error('[searchResumeToken] Failed to serialize resume token payload to JSON', serErr as Error, {
        collectionName,
      });
      throw serErr;
    }

    try {
      if (fencing && fencing.lockKey && fencing.ownerToken) {
        // Atomic evaluation: verify leader lock ownership before writing checkpoint
        const result = await redis.eval(
          FENCED_CHECKPOINT_LUA_SCRIPT,
          2,
          fencing.lockKey,
          key,
          fencing.ownerToken,
          serialized
        );

        if (Number(result) !== 1) {
          throw new FencedCheckpointError(
            `Fenced checkpoint rejected: caller with token "${fencing.ownerToken}" does not hold leader lock "${fencing.lockKey}"`,
            fencing.lockKey,
            fencing.ownerToken
          );
        }
      } else {
        // Direct SET without expiry (unfenced/standalone/test fallback)
        await redis.set(key, serialized);
      }
      logger.debug?.('[searchResumeToken] Persisted checkpoint', { collectionName, key });
    } catch (err) {
      if (err instanceof FencedCheckpointError) {
        throw err;
      }
      logger.error('[searchResumeToken] Failed to persist resume token to Redis', err as Error, {
        key,
        collectionName,
      });
      throw err;
    }
  }

  /**
   * Deletes the resume token checkpoint for a collection.
   * Used for resync operations or test fixture reset.
   */
  public async clearResumeToken(collectionName: string): Promise<void> {
    const key = getResumeTokenKey(collectionName);
    const redis = this.getClient();

    try {
      await redis.del(key);
      logger.info('[searchResumeToken] Cleared resume token checkpoint', { collectionName, key });
    } catch (err) {
      logger.error('[searchResumeToken] Failed to clear resume token from Redis', err as Error, {
        key,
        collectionName,
      });
      throw err;
    }
  }
}

// Singleton instance
let _resumeTokenStore: RedisResumeTokenStore | null = null;

export function getResumeTokenStore(redisClient?: Redis): RedisResumeTokenStore {
  if (redisClient) {
    return new RedisResumeTokenStore(redisClient);
  }
  if (!_resumeTokenStore) {
    _resumeTokenStore = new RedisResumeTokenStore();
  }
  return _resumeTokenStore;
}

export function setResumeTokenStoreForTesting(store: RedisResumeTokenStore | null): void {
  _resumeTokenStore = store;
}
