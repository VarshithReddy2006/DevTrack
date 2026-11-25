import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { Types, type ClientSession } from 'mongoose';
import { z } from 'zod';
import { Quest, type IQuest } from '../../db/models/quest.model.js';
import { UserQuestProgress } from '../../db/models/userQuestProgress.model.js';
import { LeagueStanding, LEAGUE_DIVISIONS, type LeagueDivision } from '../../db/models/leagueStanding.model.js';
import { User } from '../../db/models/user.model.js';
import { UserXp } from '../../db/models/userXp.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { logger } from '../../shared/logger.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';
import { weekKeyFor, weekRange, previousWeekKey } from '../leagues/weeks.js';

export const questObjectId = z.string().regex(/^[a-fA-F0-9]{24}$/);
export const questError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode, code: 'QUEST_ERROR' });

export function questPeriods(now: Date) {
  const dailyStart = new Date(now.toISOString().slice(0, 10));
  const weekly = weekRange(weekKeyFor(now));
  return {
    daily: { periodKey: 'daily:' + dailyStart.toISOString().slice(0, 10), startsAt: dailyStart, expiresAt: new Date(+dailyStart + 86_400_000) },
    weekly: { periodKey: 'weekly:' + weekKeyFor(now), startsAt: weekly.start, expiresAt: weekly.end },
  };
}

export function questDefinitions(division: LeagueDivision): IQuest[] {
  const tier = LEAGUE_DIVISIONS.indexOf(division);
  const goals = [
    ['daily', 'dsa_solve', 2 + tier, 'distinct problems'],
    ['daily', 'focus_minutes', 30 + tier * 10, 'qualified focus minutes'],
    ['daily', 'revision_review', 10 + tier * 2, 'flashcards'],
    ['weekly', 'dsa_solve', 10 + tier * 5, 'distinct problems'],
    ['weekly', 'focus_minutes', 150 + tier * 30, 'qualified focus minutes'],
  ] as const;
  return goals.map(([cadence, kind, targetCount, label]) => ({
    key: `v1:${division}:${cadence}:${kind}`, slot: `${cadence}:${kind}`, cadence, division, kind,
    title: `${kind === 'dsa_solve' ? 'Solve' : kind === 'focus_minutes' ? 'Complete' : 'Review'} ${targetCount} ${label}`,
    targetCount, xpReward: cadence === 'daily' ? 20 + tier * 5 : 100 + tier * 25,
    trophyReward: cadence === 'daily' ? 1 : 5 + tier,
  }));
}

// First-time unique-key races abort a transaction; retry the whole unit against
// the committed winner. Other failures must propagate rather than lose progress.
export async function questTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await runInTransaction(work); }
    catch (error) { if ((error as { code?: number }).code !== 11000 || attempt >= 3) throw error; }
  }
}

const QUEST_GEN_LOCK_TTL_MS = 5000;
const QUEST_GEN_LOCK_WAIT_MS = 100;
const QUEST_GEN_LOCK_MAX_WAIT_ATTEMPTS = 15;
const RELEASE_LOCK_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export async function generateUserQuests(userId: string, now = new Date(), cadence?: 'daily' | 'weekly') {
  questObjectId.parse(userId);
  const periods = questPeriods(now);
  const filter = { userId, periodKey: { $in: [periods.daily.periodKey, periods.weekly.periodKey] } };
  const existing = await UserQuestProgress.find(filter).sort({ cadence: 1, slot: 1 }).lean();
  const slots = questDefinitions('bronze').filter(item => !cadence || item.cadence === cadence).map(item => item.slot);
  if (slots.every(slot => existing.some(row => row.slot === slot))) return existing;

  const lockKey = `quest-gen:${userId}:${periods.daily.periodKey}:${periods.weekly.periodKey}`;
  const lockToken = randomUUID();
  let lockAcquired = false;

  if (isRedisConfigured()) {
    try {
      const redis = getRedisClient();
      const res = await redis.set(lockKey, lockToken, 'PX', QUEST_GEN_LOCK_TTL_MS, 'NX');
      lockAcquired = res === 'OK';

      if (!lockAcquired) {
        for (let attempt = 0; attempt < QUEST_GEN_LOCK_MAX_WAIT_ATTEMPTS; attempt++) {
          await new Promise(resolve => setTimeout(resolve, QUEST_GEN_LOCK_WAIT_MS));
          const refreshed = await UserQuestProgress.find(filter).sort({ cadence: 1, slot: 1 }).lean();
          if (slots.every(slot => refreshed.some(row => row.slot === slot))) return refreshed;
          const retryLock = await redis.set(lockKey, lockToken, 'PX', QUEST_GEN_LOCK_TTL_MS, 'NX');
          if (retryLock === 'OK') {
            lockAcquired = true;
            break;
          }
        }
      }
    } catch (err) {
      logger.warn('[quests] Redis lock unavailable during generateUserQuests, falling back to DB transaction', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    // Double-checked read inside the lock boundary
    const rechecked = await UserQuestProgress.find(filter).sort({ cadence: 1, slot: 1 }).lean();
    if (slots.every(slot => rechecked.some(row => row.slot === slot))) return rechecked;

    const active = await LeagueStanding.findOne({ userId, weekKey: weekKeyFor(now) }).lean();
    if (!active && await LeagueStanding.exists({ userId, weekKey: previousWeekKey(weekKeyFor(now)), status: 'active' })) {
      throw questError(503, 'League rollover is pending; retry quest generation');
    }
    const previous = active ? null : await LeagueStanding.findOne({ userId, status: 'finalized' }).sort({ weekKey: -1 }).lean();
    const division = active?.division ?? previous?.nextDivision ?? 'bronze';
    const definitions = questDefinitions(division).filter(item => !cadence || item.cadence === cadence);
    const templates: Array<(IQuest & { _id: Types.ObjectId; __v?: number }) | null> = [];
    for (const definition of definitions) {
      try {
        templates.push(await Quest.findOneAndUpdate({ key: definition.key }, { $setOnInsert: definition }, { upsert: true, new: true }).lean());
      } catch (error) {
        if ((error as { code?: number }).code !== 11000) throw error;
        templates.push(await Quest.findOne({ key: definition.key }).lean());
      }
    }
    await questTransaction(async session => {
      for (const template of templates) {
        if (!template) throw new Error('Quest definition missing');
        const { _id, key: _key, __v: _version, ...snapshot } = template;
        const period = periods[template.cadence];
        await UserQuestProgress.updateOne({ userId, slot: template.slot, periodKey: period.periodKey }, {
          $setOnInsert: { ...snapshot, userId: new Types.ObjectId(userId), questId: _id, ...period },
        }, { upsert: true, session });
      }
    });
    return UserQuestProgress.find({ userId, periodKey: { $in: [periods.daily.periodKey, periods.weekly.periodKey] } }).sort({ cadence: 1, slot: 1 }).lean();
  } finally {
    if (lockAcquired && isRedisConfigured()) {
      try {
        await getRedisClient().eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken);
      } catch (err) {
        logger.warn('[quests] Failed to release quest generation lock', {
          lockKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

export async function listUserQuests(userId: string, now = new Date()) {
  const rows = (await generateUserQuests(userId, now)).filter(
    row => row.status !== 'expired' && row.status !== 'archived'
  );
  const wallet = await UserXp.findOne({ userId }).select('leagueTrophies').lean();
  return {
    serverTime: now.toISOString(), leagueTrophies: wallet?.leagueTrophies ?? 0,
    quests: rows.map(row => ({
      questId: row._id.toString(), definitionId: row.questId.toString(), periodKey: row.periodKey,
      cadence: row.cadence, division: row.division, kind: row.kind, title: row.title,
      targetCount: row.targetCount, currentCount: row.currentCount,
      status: row.status ?? (row.completed ? 'completed' : 'in_progress'),
      completed: row.completed,
      claimed: row.claimed, completedAt: row.completedAt, claimedAt: row.claimedAt,
      startsAt: row.startsAt, expiresAt: row.expiresAt, xpReward: row.xpReward, trophyReward: row.trophyReward,
    })),
  };
}

export const QUEST_SWEEP_BATCH_SIZE = 250;
export const QUEST_SWEEP_CONCURRENCY = 10;
export const QUEST_SWEEP_CHECKPOINT_TTL_SECONDS = 24 * 60 * 60;
export const QUEST_SWEEP_CHECKPOINT_PREFIX = 'quests:generation:sweep:checkpoint';

export type SweepRedisClient = Pick<Redis, 'status' | 'get' | 'set' | 'del'>;

export interface QuestGenerationSweepOptions {
  batchSize?: number;
  concurrency?: number;
  checkpointKey?: string;
  checkpointTtlSeconds?: number;
  runId?: string;
  redisClient?: SweepRedisClient;
  shouldContinue?: () => boolean;
  processUser?: (userId: string, now: Date) => Promise<unknown>;
}

export interface QuestGenerationSweepReport {
  runId: string;
  users: number;
  failed: number;
  batches: number;
  resumedFromUserId: string | null;
  completed: boolean;
}

interface QuestSweepCheckpoint {
  runId: string;
  periodKey: string;
  lastUserId: string;
  updatedAt: string;
}

function resolveSweepRedis(redisClient?: SweepRedisClient): SweepRedisClient | null {
  try {
    const client = redisClient ?? getRedisClient();
    if (
      client &&
      client.status === 'ready' &&
      typeof client.get === 'function' &&
      typeof client.set === 'function' &&
      typeof client.del === 'function'
    ) {
      return client;
    }
  } catch (err) {
    logger.warn('[quests] Redis unavailable for sweep checkpointing', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

async function readSweepCheckpoint(
  redis: SweepRedisClient | null,
  checkpointKey: string,
  expectedPeriodKey: string
): Promise<QuestSweepCheckpoint | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(checkpointKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QuestSweepCheckpoint> | null;
    if (
      !parsed ||
      parsed.periodKey !== expectedPeriodKey ||
      typeof parsed.runId !== 'string' ||
      typeof parsed.lastUserId !== 'string' ||
      !Types.ObjectId.isValid(parsed.lastUserId)
    ) {
      logger.warn('[quests] Ignoring invalid or stale sweep checkpoint', { checkpointKey });
      return null;
    }
    return {
      runId: parsed.runId,
      periodKey: parsed.periodKey,
      lastUserId: parsed.lastUserId,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (err) {
    logger.warn('[quests] Failed to read quest sweep checkpoint from Redis', {
      checkpointKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function writeSweepCheckpoint(
  redis: SweepRedisClient | null,
  checkpointKey: string,
  checkpoint: QuestSweepCheckpoint,
  ttlSeconds: number
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(checkpointKey, JSON.stringify(checkpoint), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('[quests] Failed to persist quest sweep checkpoint to Redis', {
      checkpointKey,
      lastUserId: checkpoint.lastUserId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function clearSweepCheckpoint(
  redis: SweepRedisClient | null,
  checkpointKey: string
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(checkpointKey);
  } catch (err) {
    logger.warn('[quests] Failed to clear quest sweep checkpoint from Redis', {
      checkpointKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          const value = await worker(items[index]);
          results[index] = { status: 'fulfilled', value };
        } catch (reason) {
          results[index] = { status: 'rejected', reason };
        }
      }
    })
  );

  return results;
}

/**
 * Generates current-period quests for all users using keyset cursor pagination,
 * bounded per-batch concurrency with isolated user error handling, and Redis checkpoint resumption.
 */
export async function executeQuestGenerationSweep(
  now = new Date(),
  options: QuestGenerationSweepOptions = {}
): Promise<QuestGenerationSweepReport> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? QUEST_SWEEP_BATCH_SIZE));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? QUEST_SWEEP_CONCURRENCY));
  const ttlSeconds = Math.max(1, Math.floor(options.checkpointTtlSeconds ?? QUEST_SWEEP_CHECKPOINT_TTL_SECONDS));
  const processUser = options.processUser ?? generateUserQuests;
  const dailyPeriodKey = questPeriods(now).daily.periodKey;
  const checkpointKey = options.checkpointKey ?? `${QUEST_SWEEP_CHECKPOINT_PREFIX}:${dailyPeriodKey}`;
  const redis = resolveSweepRedis(options.redisClient);

  const existingCheckpoint = await readSweepCheckpoint(redis, checkpointKey, dailyPeriodKey);
  let lastSeenId: Types.ObjectId | null = existingCheckpoint
    ? new Types.ObjectId(existingCheckpoint.lastUserId)
    : null;
  const resumedFromUserId = existingCheckpoint?.lastUserId ?? null;
  const runId = options.runId ?? existingCheckpoint?.runId ?? randomUUID();

  let users = 0;
  let failed = 0;
  let batches = 0;
  let completed = true;

  for (;;) {
    if (options.shouldContinue && !options.shouldContinue()) {
      completed = false;
      logger.warn('[quests] Quest generation sweep interrupted before completion', {
        runId,
        lastSeenId: lastSeenId?.toString() ?? null,
      });
      break;
    }

    const filter = lastSeenId ? { _id: { $gt: lastSeenId } } : {};
    const batch = await User.find(filter)
      .sort({ _id: 1 })
      .limit(batchSize)
      .select('_id')
      .lean();

    if (batch.length === 0) break;

    batches++;
    const settled = await runWithConcurrency(batch, concurrency, (user) =>
      processUser(user._id.toString(), now)
    );

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        users++;
      } else {
        failed++;
        logger.error('[quests] Failed to generate quests for user during sweep', {
          runId,
          userId: batch[i]._id.toString(),
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      }
    }

    lastSeenId = batch[batch.length - 1]._id as Types.ObjectId;
    await writeSweepCheckpoint(
      redis,
      checkpointKey,
      {
        runId,
        periodKey: dailyPeriodKey,
        lastUserId: lastSeenId.toString(),
        updatedAt: new Date().toISOString(),
      },
      ttlSeconds
    );

    if (batch.length < batchSize) break;
  }

  if (completed) {
    await clearSweepCheckpoint(redis, checkpointKey);
  }

  logger.info('[quests] Quest generation sweep finished', {
    event: 'quests_generation_sweep',
    runId,
    users,
    failed,
    batches,
    resumedFromUserId,
    completed,
  });

  return {
    runId,
    users,
    failed,
    batches,
    resumedFromUserId,
    completed,
  };
}

export async function runQuestGenerationSweep(
  now = new Date(),
  options: QuestGenerationSweepOptions = {}
): Promise<{ users: number }> {
  const report = await executeQuestGenerationSweep(now, options);
  return { users: report.users };
}

export interface QuestExpirationSweepResult {
  expiredCount: number;
  archivedCount: number;
  invalidatedUsers: number;
}

/**
 * Transitions stale in-progress quests past their deadline to 'expired',
 * invalidates affected user caches, and archives quest records older than archiveAfterDays.
 */
export async function expireStaleQuests(
  batchSize = 200,
  now = new Date(),
  archiveAfterDays = 90
): Promise<QuestExpirationSweepResult> {
  const limit = Math.max(1, Math.floor(batchSize));
  let expiredCount = 0;
  let archivedCount = 0;
  const affectedUsers = new Set<string>();

  for (;;) {
    const stale = await UserQuestProgress.find({
      expiresAt: { $lt: now },
      completed: false,
      $or: [{ status: 'in_progress' }, { status: { $exists: false } }],
    })
      .select('_id userId currentCount targetCount')
      .limit(limit)
      .lean();

    if (stale.length === 0) break;

    const ops = stale.map(doc => {
      const finalProgressPct =
        doc.targetCount > 0
          ? Math.min(100, Math.round((doc.currentCount / doc.targetCount) * 10000) / 100)
          : 0;
      return {
        updateOne: {
          filter: {
            _id: doc._id,
            completed: false,
            expiresAt: { $lt: now },
            status: { $nin: ['completed', 'expired', 'archived'] },
          },
          update: {
            $set: {
              status: 'expired' as const,
              expiredAt: now,
              finalProgressPct,
            },
          },
        },
      };
    });

    const writeResult = await UserQuestProgress.bulkWrite(ops, { ordered: false });
    expiredCount += writeResult.modifiedCount ?? 0;

    if ((writeResult.modifiedCount ?? 0) > 0) {
      for (const doc of stale) {
        affectedUsers.add(doc.userId.toString());
      }
    }

    if (stale.length < limit) break;
  }

  if (affectedUsers.size > 0) {
    const invalidations = await Promise.allSettled(
      Array.from(affectedUsers, uid => cacheManager.invalidateAllUserCache(uid))
    );
    for (const outcome of invalidations) {
      if (outcome.status === 'rejected') {
        logger.warn('[quests] Failed to invalidate user cache after quest expiration', {
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      }
    }
  }

  const archiveCutoff = new Date(now.getTime() - archiveAfterDays * 86_400_000);
  for (;;) {
    const archivable = await UserQuestProgress.find({
      expiresAt: { $lt: archiveCutoff },
      status: { $ne: 'archived' },
    })
      .select('_id')
      .limit(limit)
      .lean();

    if (archivable.length === 0) break;

    const ids = archivable.map(doc => doc._id);
    const archiveResult = await UserQuestProgress.updateMany(
      { _id: { $in: ids }, status: { $ne: 'archived' } },
      { $set: { status: 'archived', archivedAt: now } }
    );
    archivedCount += archiveResult.modifiedCount ?? 0;

    if (archivable.length < limit) break;
  }

  logger.info('[quests] Quest expiration sweep completed', {
    event: 'quests_expiration_sweep',
    expiredCount,
    archivedCount,
    invalidatedUsers: affectedUsers.size,
  });

  return {
    expiredCount,
    archivedCount,
    invalidatedUsers: affectedUsers.size,
  };
}
