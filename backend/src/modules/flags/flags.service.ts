import { createHash, randomUUID } from 'node:crypto';
import { FeatureFlag, type FeatureFlagSettings, type IFeatureFlag } from '../../db/models/featureFlag.model.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';

const CACHE_TTL_SECONDS = 60;
const CACHE_TIMEOUT_MS = 200;
const CACHE_GENERATION = 'devtrack:flags:catalog-generation';

function readyFlagCache() {
  if (!isRedisConfigured()) return null;
  const redis = getRedisClient();
  return redis.status === 'ready' ? redis : null;
}

async function cacheCommand<T>(command: Promise<T>): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      command,
      new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), CACHE_TIMEOUT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function cacheUnavailable(message: string) {
  return Object.assign(new Error(message), { statusCode: 503, code: 'FLAG_CACHE_UNAVAILABLE' });
}

export function evaluateFlag(flag: IFeatureFlag, userId: string): boolean {
  if (!flag.enabled) return false;
  if (flag.allowedUserIds.includes(userId)) return true;
  const bucket = createHash('sha256').update(userId).update(':').update(flag.key).digest().readUInt32BE(0) % 100;
  return bucket < flag.rolloutPercent;
}

async function flagCatalog(): Promise<IFeatureFlag[]> {
  const redis = readyFlagCache();
  if (!redis) return listFlags();

  let generation = await cacheCommand(redis.get(CACHE_GENERATION));
  if (!generation) {
    const initialGeneration = randomUUID();
    const initialized = await cacheCommand(redis.set(CACHE_GENERATION, initialGeneration, 'NX'));
    generation = initialized === 'OK' ? initialGeneration : await cacheCommand(redis.get(CACHE_GENERATION));
    if (!generation) return listFlags();
  }

  const catalogKey = `devtrack:flags:catalog:${generation}`;
  const cached = await cacheCommand(redis.get(catalogKey));
  if (cached) {
    try {
      const flags: unknown = JSON.parse(cached);
      if (Array.isArray(flags)) return flags as IFeatureFlag[];
    } catch {
      // A malformed entry is replaced from MongoDB.
    }
  }

  // Refills retain the version captured before the read. An admin write can
  // rotate the generation concurrently and keep that refill unreachable.
  const flags = await listFlags();
  await cacheCommand(redis.set(catalogKey, JSON.stringify(flags), 'EX', CACHE_TTL_SECONDS));
  return flags;
}

async function isEnabledForUser(flag: IFeatureFlag, userId: string): Promise<boolean> {
  const redis = readyFlagCache();
  if (!redis) return evaluateFlag(flag, userId);

  const key = `devtrack:flags:${userId}:${flag.key}:v${flag.version}`;
  const cached = await cacheCommand(redis.get(key));
  if (cached === '1' || cached === '0') return cached === '1';

  const enabled = evaluateFlag(flag, userId);
  await cacheCommand(redis.set(key, enabled ? '1' : '0', 'EX', CACHE_TTL_SECONDS));
  return enabled;
}

export async function isFlagEnabled(key: string, userId: string): Promise<boolean> {
  const flag = (await flagCatalog()).find(flag => flag.key === key);
  return flag ? isEnabledForUser(flag, userId) : false;
}

export async function activeFlagKeys(userId: string): Promise<string[]> {
  const flags = await flagCatalog();
  const decisions = await Promise.all(flags.map(flag => isEnabledForUser(flag, userId)));
  return flags.filter((_flag, index) => decisions[index]).map(flag => flag.key);
}

export function listFlags() {
  return FeatureFlag.find().select('-_id -__v').sort({ key: 1 }).lean().exec();
}

export async function updateFlag(key: string, changes: Partial<FeatureFlagSettings>) {
  const redis = readyFlagCache();
  if (isRedisConfigured() && !redis) {
    throw cacheUnavailable('Feature flag cache is unavailable. The flag was not updated.');
  }

  const flag = await FeatureFlag.findOneAndUpdate({ key }, {
    $set: changes,
    $setOnInsert: changes.name === undefined ? { name: key } : {},
    $inc: { version: 1 },
  }, { new: true, upsert: true, runValidators: true }).select('-_id -__v').lean().exec();

  if (redis && await cacheCommand(redis.set(CACHE_GENERATION, randomUUID())) !== 'OK') {
    throw cacheUnavailable('The flag was saved, but cache invalidation could not be confirmed.');
  }
  return flag;
}
