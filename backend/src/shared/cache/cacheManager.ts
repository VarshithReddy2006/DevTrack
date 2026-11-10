// src/shared/cache/cacheManager.ts — Cache lifecycle management
// Phase-1 Hardening: Cache invalidation guarantees

import { getRedisClient } from '../redis/client.js';
import { logger } from '../logger.js';

const DEFAULT_TTL = 300; // 5 minutes
const STALE_TTL = 60; // 1 minute for stale data

// Cache key patterns
export const CACHE_KEYS = {
  userAnalytics: (userId: string) => `cache:analytics:${userId}`,
  userStreak: (userId: string) => `cache:streak:${userId}`,
  userXp: (userId: string) => `cache:xp:${userId}`,
  dashboard: (userId: string) => `cache:dashboard:${userId}`,
  leaderboard: (type: string) => `cache:leaderboard:${type}`,
} as const;

// Coalescing is per API process. Redis generations fence stale fills against
// invalidations made by any API or worker process.
const IN_FLIGHT_KEYS = new Map<string, { generation: string | null; promise: Promise<unknown> }>();
const readStats = { hits: 0, misses: 0, coalesced: 0, loads: 0, bypasses: 0, errors: 0 };
const generationKey = (key: string) => `${key}:generation`;
// The shared Redis connection also serves blocking queues and retries forever.
// Dashboard cache I/O must be bounded if a ready connection loses connectivity.
async function cacheCommand<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cache command timed out')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const INVALIDATE = `
  for i = 1, #KEYS, 2 do
    redis.call('INCR', KEYS[i + 1])
    redis.call('DEL', KEYS[i])
  end
  return 1
`;
const PUBLISH = `
  if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
`;

async function invalidate(keys: string[]): Promise<void> {
  for (const key of keys) IN_FLIGHT_KEYS.delete(key);
  try {
    const redis = getRedisClient();
    if (redis.status !== 'ready') return;
    const scriptKeys = keys.flatMap(key => [key, generationKey(key)]);
    await cacheCommand(redis.eval(INVALIDATE, scriptKeys.length, ...scriptKeys));
  } catch (error) {
    readStats.errors++;
    logger.warn('[cache] Invalidation failed (non-fatal)', { error });
  }
}

export const cacheManager = {
  // DB writes commit first. Cache failures must not reject a committed write.
  async invalidateUserAnalytics(userId: string): Promise<void> {
    await invalidate([CACHE_KEYS.userAnalytics(userId)]);
  },

  async invalidateUserStreak(userId: string): Promise<void> {
    await invalidate([CACHE_KEYS.userStreak(userId)]);
  },

  async invalidateUserXp(userId: string): Promise<void> {
    await invalidate([CACHE_KEYS.userXp(userId)]);
  },

  async invalidateDashboard(userId: string): Promise<void> {
    await invalidate([CACHE_KEYS.dashboard(userId)]);
  },

  async invalidateAllUserCache(userId: string): Promise<void> {
    await invalidate([
      CACHE_KEYS.userAnalytics(userId), CACHE_KEYS.userStreak(userId),
      CACHE_KEYS.userXp(userId), CACHE_KEYS.dashboard(userId),
    ]);
  },

  getReadStats() {
    return { ...readStats, inFlight: IN_FLIGHT_KEYS.size };
  },

  async getOrSet<T>(key: string, fetcher: () => Promise<T>, ttl = DEFAULT_TTL): Promise<T> {
    let redis: ReturnType<typeof getRedisClient> | undefined;
    let generation: string | null = null;
    try {
      const client = getRedisClient();
      if (client.status === 'ready') {
        // Read the cached value and its invalidation generation atomically.
        const [cached, version] = await cacheCommand(client.mget(key, generationKey(key)));
        redis = client;
        generation = version ?? '0';
        if (cached !== null) {
          try {
            const value = JSON.parse(cached) as T;
            readStats.hits++;
            return value;
          } catch {
            // Corrupt entries are ordinary misses and will be replaced.
          }
        }
      }
    } catch (error) {
      readStats.errors++;
      logger.warn('[cache] Read failed, fetching from DB', { key, error });
    }
    if (redis) readStats.misses++;
    else readStats.bypasses++;

    const inFlight = IN_FLIGHT_KEYS.get(key);
    if (inFlight && inFlight.generation === generation) {
      readStats.coalesced++;
      return await inFlight.promise as T;
    }

    // Register before invoking the fetcher (including synchronous throws).
    const entry = { generation, promise: Promise.resolve() as Promise<unknown> };
    entry.promise = Promise.resolve().then(async () => {
      readStats.loads++;
      const data = await fetcher();
      if (redis && IN_FLIGHT_KEYS.get(key) === entry) {
        try {
          // A worker may have invalidated while the API was reading the DB.
          await cacheCommand(redis.eval(PUBLISH, 2, key, generationKey(key), generation!, JSON.stringify(data), ttl));
        } catch (error) {
          readStats.errors++;
          logger.warn('[cache] Fill failed (non-fatal)', { key, error });
        }
      }
      return data;
    }).finally(() => {
      if (IN_FLIGHT_KEYS.get(key) === entry) IN_FLIGHT_KEYS.delete(key);
    });
    IN_FLIGHT_KEYS.set(key, entry);
    return await entry.promise as T;
  },

  async getStale<T>(
    key: string,
    fetcher: () => Promise<T>,
    staleTtl = STALE_TTL
  ): Promise<{ data: T | null; isStale: boolean }> {
    const redis = getRedisClient();
    if (redis.status !== 'ready') {
      logger.warn('[cache] Redis not ready, fetching fresh stale data', { key });
      const data = await fetcher();
      return { data, isStale: false };
    }

    const cached = await redis.get(key);
    if (cached) {
      try {
        const data = JSON.parse(cached) as T;
        const ttl = await redis.ttl(key);

        // If TTL is very low, trigger background refresh
        if (ttl < 3 && ttl > 0) {
          // Fire and forget refresh
          this.getOrSet(key, fetcher, DEFAULT_TTL).catch((err) => {
            logger.warn('[cache] Background refresh failed', { key, error: err });
          });
        }

        return { data, isStale: ttl <= 0 };
      } catch (err) {
        logger.debug('[cache] Invalid cache entry in SWR, fetching fresh', { key, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // No cache, fetch and cache
    const data = await this.getOrSet(key, fetcher, DEFAULT_TTL);
    return { data, isStale: false };
  },

  // ─── Cache warming ──────────────────────────────────────────────────────
  // Pre-populate cache for known users

  async warmUserCache(userId: string, data: Record<string, unknown>): Promise<void> {
    const redis = getRedisClient();
    if (redis.status !== 'ready') {
      logger.warn('[cache] Redis not ready, skip cache warm', { userId });
      return;
    }

    const pipeline = redis.pipeline();
    pipeline.set(CACHE_KEYS.userAnalytics(userId), JSON.stringify(data.analytics), 'EX', DEFAULT_TTL);
    pipeline.set(CACHE_KEYS.userStreak(userId), JSON.stringify(data.streak), 'EX', DEFAULT_TTL);
    pipeline.set(CACHE_KEYS.userXp(userId), JSON.stringify(data.xp), 'EX', DEFAULT_TTL);

    await pipeline.exec();
    logger.debug('[cache] Warmed user cache', { userId });
  },

  // ─── Cache statistics ───────────────────────────────────────────────────

  async getCacheStats(pattern: string): Promise<{ keys: number; memory: string }> {
    const redis = getRedisClient();
    if (redis.status !== 'ready') {
      return { keys: 0, memory: 'N/A' };
    }
    const keys = await redis.keys(pattern);

    return {
      keys: keys.length,
      memory: 'N/A', // Requires DEBUG OBJECT for memory estimation
    };
  },

  // ─── Health check ───────────────────────────────────────────────────────

  async healthCheck(): Promise<{ status: string; keys: number }> {
    const redis = getRedisClient();
    if (redis.status !== 'ready') {
      return { status: 'unhealthy', keys: 0 };
    }

    try {
      await redis.ping();
      const keys = (await redis.dbsize()) || 0;
      return { status: 'healthy', keys };
    } catch (err) {
      logger.warn('[cache] Health check failed', { error: err instanceof Error ? err.message : String(err) });
      return { status: 'unhealthy', keys: 0 };
    }
  },

  async cacheHealth(): Promise<any> {
    const redis = getRedisClient();
    if (redis.status !== 'ready') {
      return { status: 'unhealthy', error: 'Redis connection is not ready' };
    }
    try {
      const info = await redis.info();
      const dbSize = await redis.dbsize();
      
      const parseInfo = (str: string) => {
        const lines = str.split('\r\n');
        const parsed: Record<string, string> = {};
        for (const line of lines) {
          if (line.includes(':')) {
            const [key, value] = line.split(':');
            parsed[key] = value;
          }
        }
        return parsed;
      };

      const parsedInfo = parseInfo(info);
      const publicKeysCount = (await redis.keys('public_profile:*')).length;

      return {
        status: 'healthy',
        keys: dbSize,
        publicProfileKeys: publicKeysCount,
        memoryUsed: parsedInfo.used_memory_human,
        memoryFragmentationRatio: parsedInfo.mem_fragmentation_ratio,
        hitRate: 'N/A (Requires Redis monitoring)',
        uptime: parsedInfo.uptime_in_seconds,
        connectedClients: parsedInfo.connected_clients
      };
    } catch (e) {
      return { status: 'unhealthy', error: String(e) };
    }
  }
};

export default cacheManager;
