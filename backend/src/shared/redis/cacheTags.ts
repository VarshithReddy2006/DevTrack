import { getRedisClient } from './client.js';
import { logger } from '../logger.js';

const COMMAND_TIMEOUT_MS = 100;
export const portfolioTag = (userId: string) => `user:${userId.toLowerCase()}`;
const tagKey = (tag: string) => `cache:tag:${tag}`;
const generationKey = (tag: string) => `${tagKey(tag)}:generation`;

// The generation is persistent: expiring it would let a delayed fill reuse generation zero.
export const WRITE_TAGGED_CACHE = `
  if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  redis.call('SET', KEYS[4], ARGV[4], 'EX', ARGV[3])
  redis.call('SADD', KEYS[3], KEYS[1])
  redis.call('EXPIRE', KEYS[3], ARGV[3] + 60)
  return 1
`;
export const INVALIDATE_CACHE_TAG = `
  redis.call('INCR', KEYS[1])
  local members = redis.call('SMEMBERS', KEYS[2])
  for _, key in ipairs(members) do
    if redis.call('GET', key .. ':tag') == ARGV[1] then redis.call('DEL', key, key .. ':tag') end
  end
  redis.call('DEL', KEYS[2])
  return #members
`;

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tagged cache command timed out')), COMMAND_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

/** Cache failures bypass Redis. The caller must still authorize the underlying public data. */
export async function readTaggedCache(key: string, tag: string): Promise<{ value: string | null; generation: string } | null> {
  try {
    const redis = getRedisClient();
    if (redis.status !== 'ready') return null;
    const [value, generation] = await bounded(redis.mget(key, generationKey(tag)));
    return { value, generation: generation ?? '0' };
  } catch (error) {
    logger.warn('[cache-tags] Read bypassed', { error });
    return null;
  }
}

export async function writeTaggedCache(key: string, tag: string, generation: string, value: string, ttl: number): Promise<void> {
  try {
    const redis = getRedisClient();
    if (redis.status !== 'ready') return;
    await bounded(redis.eval(WRITE_TAGGED_CACHE, 4, key, generationKey(tag), tagKey(tag), `${key}:tag`, generation, value, ttl, tag));
  } catch (error) { logger.warn('[cache-tags] Fill bypassed', { error }); }
}

export async function invalidateCacheTag(tag: string): Promise<void> {
  try {
    const redis = getRedisClient();
    if (redis.status !== 'ready') return;
    await bounded(redis.eval(INVALIDATE_CACHE_TAG, 2, generationKey(tag), tagKey(tag), tag));
  } catch (error) { logger.warn('[cache-tags] Invalidation failed; reads still check publication/privacy', { error }); }
}

export async function discardTaggedCacheKey(key: string): Promise<void> {
  try {
    const redis = getRedisClient();
    if (redis.status === 'ready') await bounded(redis.del(key, `${key}:tag`));
  } catch (error) { logger.warn('[cache-tags] Discard bypassed', { error }); }
}
