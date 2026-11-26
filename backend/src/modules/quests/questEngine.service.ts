import { randomUUID } from 'node:crypto';
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

export async function runQuestGenerationSweep(now = new Date()) {
  let users = 0;
  for await (const user of User.find().select('_id').lean().cursor({ batchSize: 100 })) {
    await generateUserQuests(user._id.toString(), now);
    users++;
  }
  return { users };
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
    const modifiedCount = writeResult.modifiedCount ?? 0;
    expiredCount += modifiedCount;

    if (modifiedCount > 0) {
      for (const doc of stale) {
        affectedUsers.add(doc.userId.toString());
      }
    }

    if (modifiedCount === 0 || stale.length < limit) break;
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
    const modifiedCount = archiveResult.modifiedCount ?? 0;
    archivedCount += modifiedCount;

    if (modifiedCount === 0 || archivable.length < limit) break;
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
