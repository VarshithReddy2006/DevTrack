// src/modules/leagues/scoreStore.ts — Narrow interface over the Redis sorted sets that hold live standings.
// The leagues code only talks to LeagueScoreStore, so unit tests can use an in-memory fake
// and never need a Redis server.

import type { Redis } from 'ioredis';
import { getRedisClient } from '../../shared/redis/index.js';
import { SCORE_DEDUPE_TTL_SECONDS } from './leagues.constants.js';

export interface ScoreEntry {
  member: string;
  score: number;
}

export interface LeagueScoreStore {
  /**
   * ZINCRBY, applied at most once per dedupe id. Resolves with the new score,
   * or null when this award was already applied.
   */
  incrementOnce(
    key: string,
    member: string,
    delta: number,
    dedupe: { setKey: string; id: string },
  ): Promise<number | null>;
  /** ZADD NX with score 0: makes members appear on the board without touching existing scores. */
  seed(key: string, members: string[]): Promise<void>;
  /** Replaces the whole sorted set (used when rebuilding from the XP ledger). */
  replace(key: string, entries: ScoreEntry[]): Promise<void>;
  /** ZREM */
  remove(key: string, member: string): Promise<void>;
  /** Batch ZREM for multiple members (used when purging partially seeded members from pre-existing keys). */
  removeMany(key: string, members: string[]): Promise<void>;
  /** ZREVRANGE key start stop WITHSCORES, highest score first. */
  ranked(key: string, start: number, stop: number): Promise<ScoreEntry[]>;
  exists(key: string): Promise<boolean>;
  expire(key: string, seconds: number): Promise<void>;
  /** Deletes a sorted set key (used for saga compensation rollback). */
  del(key: string): Promise<void>;
}

// Add to the applied-set first; only a first-time award touches the score. Atomic in Redis.
const INCREMENT_ONCE_LUA = `
if redis.call('SADD', KEYS[2], ARGV[2]) == 0 then return false end
redis.call('EXPIRE', KEYS[2], ARGV[3])
return redis.call('ZINCRBY', KEYS[1], ARGV[1], ARGV[4])
`;

type RedisLike = Pick<Redis, 'eval' | 'zadd' | 'zrem' | 'zrevrange' | 'exists' | 'expire' | 'del' | 'multi'>;

export function createRedisScoreStore(client: RedisLike): LeagueScoreStore {
  return {
    async incrementOnce(key, member, delta, dedupe) {
      const result = await client.eval(
        INCREMENT_ONCE_LUA, 2, key, dedupe.setKey, String(delta), dedupe.id, String(SCORE_DEDUPE_TTL_SECONDS), member,
      );
      return result === null || result === false || result === undefined ? null : Number(result);
    },

    async seed(key, members) {
      if (members.length === 0) return;
      const args: (string | number)[] = [];
      for (const member of members) args.push(0, member);
      await client.zadd(key, 'NX', ...(args as [number, string]));
    },

    async replace(key, entries) {
      const pipeline = client.multi().del(key);
      if (entries.length > 0) {
        const args: (string | number)[] = [];
        for (const { member, score } of entries) args.push(score, member);
        pipeline.zadd(key, ...(args as [number, string]));
      }
      await pipeline.exec();
    },

    async remove(key, member) {
      await client.zrem(key, member);
    },

    async removeMany(key, members) {
      if (members.length === 0) return;
      await client.zrem(key, ...members);
    },

    async ranked(key, start, stop) {
      const flat = await client.zrevrange(key, start, stop, 'WITHSCORES');
      const entries: ScoreEntry[] = [];
      for (let i = 0; i < flat.length; i += 2) entries.push({ member: flat[i], score: Number(flat[i + 1]) });
      return entries;
    },

    async exists(key) {
      return (await client.exists(key)) === 1;
    },

    async expire(key, seconds) {
      await client.expire(key, seconds);
    },

    async del(key) {
      await client.del(key);
    },
  };
}

let defaultStore: LeagueScoreStore | null = null;

/** Lazily bound so importing this module never opens a Redis connection. */
export function getLeagueScoreStore(): LeagueScoreStore {
  defaultStore ??= createRedisScoreStore(getRedisClient());
  return defaultStore;
}
