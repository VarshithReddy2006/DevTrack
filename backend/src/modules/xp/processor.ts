// src/modules/xp/processor.ts — XP processing engine with idempotency
// Processes XP events, persists transactions, aggregates UserXp state.
// All XP awards MUST flow through this module — no direct UserXp writes elsewhere.

import { Types } from 'mongoose';
import { UserXp, XpTransaction, UserAnalytics, Mission, type IUserXp } from '../../db/models/index.js';
import { eventBus } from '../../shared/sse/index.js';
import { logger } from '../../shared/logger.js';
import {
  calculateLevel,
  xpToNextLevel,
  xpForDifficulty,
  calculateMilestoneXp,
  XP_REWARDS,
} from './rules.js';
import type { XpSourceType } from '../../db/models/index.js';
import { updateMissionProgress } from '../missions/missionProgress.service.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { unifiedRuntimeStateService } from '../runtime-state/unifiedRuntimeState.service.js';

export interface XpEventPayload {
  userId: string;
  sourceType: XpSourceType;
  sourceId: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export interface XpProcessingResult {
  awarded: boolean;
  xpAwarded: number;
  duplicate: boolean;
  levelBefore: number;
  levelAfter: number;
  leveledUp: boolean;
  newTotalXp: number;
}

// ─── Core XP processor ───────────────────────────────────────────────────────

export async function processXpEvent(payload: XpEventPayload): Promise<XpProcessingResult> {
  return applyXpEvent(payload);
}

// Internal mission entry point: callers supply identity, never a reward amount.
// Retain the existing manual/mission_<id> ledger key, including historical zeros.
export async function processMissionReward(userId: string, missionId: string): Promise<XpProcessingResult> {
  const mission = await Mission.findOne({
    _id: new Types.ObjectId(missionId),
    userId: new Types.ObjectId(userId),
    status: 'completed',
    expiresAt: { $gte: new Date() },
  }).lean();

  if (!mission || !mission.completedAt || !(mission.targetCount > 0 && mission.currentCount >= mission.targetCount)) {
    throw new Error('Mission is not eligible for a completion reward');
  }
  // Generated mission rewards are whole XP points with exact numeric values.
  if (!Number.isSafeInteger(mission.xpReward) || mission.xpReward < 0) {
    throw new Error('Mission reward must be a nonnegative safe integer');
  }

  return applyXpEvent({
    userId, sourceType: 'manual', sourceId: `mission_${mission._id.toString()}`,
    metadata: { missionTitle: mission.title, missionType: mission.type, xpReward: mission.xpReward },
  }, mission.xpReward);
}

// Only validated internal mission/milestone entry points can supply this override.
async function applyXpEvent(payload: XpEventPayload, missionReward?: number): Promise<XpProcessingResult> {
  const { userId, sourceType, sourceId, difficulty, metadata, requestId } = payload;
  const userObjId = new Types.ObjectId(userId);

  // ── Step 1: Check idempotency — reject duplicate awards ─────────────────
  const existingTransaction = await XpTransaction.findOne({ userId: userObjId, sourceType, sourceId });
  if (existingTransaction) {
    logger.debug('[xp] Duplicate XP event rejected', {
      event: 'xp_duplicate_rejected',
      userId,
      sourceType,
      sourceId,
      requestId,
    });
    return {
      awarded: false,
      xpAwarded: 0,
      duplicate: true,
      levelBefore: existingTransaction.levelAfter,
      levelAfter: existingTransaction.levelAfter,
      leveledUp: false,
      newTotalXp: existingTransaction.newTotalXp,
    };
  }

  // ── Step 2: Calculate XP award ───────────────────────────────────────────
  const xpAwarded = missionReward ?? calculateXpAward(sourceType, difficulty, metadata);

  if (!Number.isSafeInteger(xpAwarded) || xpAwarded < 0) throw new Error('XP award must be a nonnegative safe integer');

  // Establish the unique aggregate outside the transaction. Concurrent first
  // awards may race on this upsert; only the userId duplicate is recoverable.
  try {
    await UserXp.updateOne({ userId: userObjId }, { $setOnInsert: { userId: userObjId } }, { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000 || !await UserXp.exists({ userId: userObjId })) throw error;
  }
  const incSet: Record<string, number> = {
    totalXp: xpAwarded,
    'lifetimeStats.totalXpEarned': xpAwarded,
  };
  if (sourceType === 'dsa_accepted' && difficulty) {
    incSet['lifetimeStats.totalProblemsSolved'] = 1;
    if (difficulty === 'easy') incSet['lifetimeStats.easySolved'] = 1;
    if (difficulty === 'medium') incSet['lifetimeStats.mediumSolved'] = 1;
    if (difficulty === 'hard') incSet['lifetimeStats.hardSolved'] = 1;
  }
  if (sourceType === 'dsa_contest') incSet['lifetimeStats.totalContests'] = 1;
  if (sourceType === 'daily_streak') incSet['lifetimeStats.dailyStreaks'] = 1;
  if (sourceType === 'sync_completed') incSet['lifetimeStats.totalSyncs'] = 1;

  let transition: XpProcessingResult;
  try {
    // The driver retries transient write conflicts and ambiguous commits.
    // No external effects run inside a callback that can be retried.
    transition = await UserXp.db.transaction(async session => {
      const duplicate = await XpTransaction.findOne({ userId: userObjId, sourceType, sourceId }).session(session);
      if (duplicate) return duplicateResult(duplicate);
      const userXp = await UserXp.findOne({ userId: userObjId }).session(session);
      if (!userXp) throw new Error('XP aggregate missing');
      const previousTotalXp = userXp.totalXp;
      const newTotalXp = previousTotalXp + xpAwarded;
      if (!Number.isSafeInteger(newTotalXp)) throw new Error('XP award would produce an unsafe XP total');
      const levelBefore = calculateLevel(previousTotalXp);
      const levelAfter = calculateLevel(newTotalXp);
      await UserXp.updateOne({ _id: userXp._id }, {
        $inc: incSet,
        $set: { currentLevel: levelAfter, xpToNextLevel: xpToNextLevel(newTotalXp, levelAfter), lastXpGainedAt: new Date() },
      }, { session });
      await XpTransaction.create([{
        userId: userObjId, sourceType, sourceId, xpAwarded,
        previousTotalXp, newTotalXp, levelBefore, levelAfter, metadata: metadata ?? {},
      }], { session });
      return { awarded: true, xpAwarded, duplicate: false, levelBefore, levelAfter,
        leveledUp: levelAfter > levelBefore, newTotalXp };
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // A competing idempotency-key insertion aborts this whole transaction,
    // including its aggregate increment. Return only a committed matching row.
    const duplicate = await XpTransaction.findOne({ userId: userObjId, sourceType, sourceId });
    if (!duplicate) throw error;
    return duplicateResult(duplicate);
  }
  if (transition.duplicate) return transition;
  const { levelBefore, levelAfter, leveledUp, newTotalXp } = transition;

  // Publish every crossed threshold, and only after the transaction commits.
  eventBus.emitXpUpdated(userId, newTotalXp, xpAwarded, levelAfter, xpToNextLevel(newTotalXp, levelAfter));
  for (let level = levelBefore + 1; level <= levelAfter; level++) {
    eventBus.emitLevelUp(userId, level, newTotalXp);
  }
  // ── Step 7: Sync to UserAnalytics ────────────────────────────────────────
  await syncUserAnalytics(userId, newTotalXp, xpAwarded, levelAfter, sourceType);

  // ── Step 8: Cache invalidation ───────────────────────────────────────────
  try {
    await cacheManager.invalidateAllUserCache(userId);
  } catch (err) {
    logger.warn('[xp] Cache invalidation failed (non-fatal)', { error: err });
  }

  // ── Step 9: Runtime state sync ──────────────────────────────────────────
  try {
    await unifiedRuntimeStateService.updateFromEvent({
      eventId: `xp_${sourceId}_${Date.now()}`,
      eventType: 'xp_awarded',
      userId,
      timestamp: new Date(),
      data: {
        xpAwarded,
        newTotalXp,
        levelBefore,
        levelAfter,
        xpToNextLevel: xpToNextLevel(newTotalXp, levelAfter),
      },
    });
  } catch (err) {
    logger.warn('[xp] Runtime state sync failed (non-fatal)', { error: err });
  }

  // ── Step 10: Update mission progress ─────────────────────────────────────
  // Publish the base state before a nested bonus, so an older base level cannot
  // overwrite the bonus's level-up. Manual mission awards do not re-enter here.
  if (sourceType === 'dsa_accepted') {
    await updateMissionProgress(userId, 'dsa_solve', { difficulty });
  } else if (sourceType === 'dsa_contest') {
    await updateMissionProgress(userId, 'dsa_contest');
  } else if (sourceType === 'daily_streak') {
    await updateMissionProgress(userId, 'streak_day');
  } else if (sourceType === 'sync_completed') {
    await updateMissionProgress(userId, 'sync');
  }

  logger.info('[xp] XP awarded', {
    event: 'xp_awarded',
    userId,
    sourceType,
    sourceId,
    xpAwarded,
    newTotalXp,
    levelBefore,
    levelAfter,
    leveledUp,
    requestId,
  });

  return {
    awarded: true,
    xpAwarded,
    duplicate: false,
    levelBefore,
    levelAfter,
    leveledUp,
    newTotalXp,
  };
}

// ─── XP award calculator ────────────────────────────────────────────────────

function calculateXpAward(
  sourceType: XpSourceType,
  difficulty?: 'easy' | 'medium' | 'hard',
  metadata?: Record<string, unknown>
): number {
  switch (sourceType) {
    case 'dsa_accepted': return xpForDifficulty(difficulty);
    case 'dsa_contest': return XP_REWARDS.contestParticipated;
    case 'daily_streak': return XP_REWARDS.dailyStreak;
    case 'sync_completed': return XP_REWARDS.syncCompleted;
    case 'focus_session': return 50; // Pomodoro/Focus session reward
    case 'challenge_completed': return typeof metadata?.xpReward === 'number' ? metadata.xpReward : 35;
    case 'milestone': return 0;
    case 'manual': return 0;
    default: return 0;
  }
}

// ─── Milestone bonus processor ─────────────────────────────────────────────

export async function processMilestoneXp(
  userId: string,
  totalSolved: number,
  requestId?: string
): Promise<void> {
  const milestoneXp = calculateMilestoneXp(totalSolved);
  if (milestoneXp === 0) return;

  await applyXpEvent({
    userId, sourceType: 'milestone', sourceId: `milestone_${totalSolved}`, requestId,
    metadata: { totalSolved, reason: `${totalSolved} problems solved` },
  }, milestoneXp);
}

function duplicateResult(transaction: { levelAfter: number; newTotalXp: number }): XpProcessingResult {
  return { awarded: false, xpAwarded: 0, duplicate: true, levelBefore: transaction.levelAfter,
    levelAfter: transaction.levelAfter, leveledUp: false, newTotalXp: transaction.newTotalXp };
}
// ─── Read-only UserXp fetch ─────────────────────────────────────────────────

export async function getUserXp(userId: string): Promise<{
  totalXp: number;
  currentLevel: number;
  xpToNextLevel: number;
  xpInCurrentLevel: number;
  progressPercent: number;
  lifetimeStats: IUserXp['lifetimeStats'];
} | null> {
  const userXp = await UserXp.findOne({ userId: new Types.ObjectId(userId) });
  if (!userXp) return null;

  const { xpInCurrentLevel: getXpInCurrentLevel, xpProgressPercent } = await import('./rules.js');

  return {
    totalXp: userXp.totalXp,
    currentLevel: userXp.currentLevel,
    xpToNextLevel: userXp.xpToNextLevel,
    xpInCurrentLevel: getXpInCurrentLevel(userXp.totalXp, userXp.currentLevel),
    progressPercent: xpProgressPercent(userXp.totalXp, userXp.currentLevel),
    lifetimeStats: userXp.lifetimeStats,
  };
}

// ─── UserAnalytics sync ───────────────────────────────────────────────────

async function syncUserAnalytics(
  userId: string,
  totalXp: number,
  xpAwarded: number,
  currentLevel: number,
  sourceType: XpSourceType
): Promise<void> {
  try {
    const userObjId = new Types.ObjectId(userId);

    // Get DSA solve count from lifetime stats
    const userXp = await UserXp.findOne({ userId: userObjId });
    const dsaSolveCount = userXp?.lifetimeStats?.totalProblemsSolved ?? 0;

    // Get weekly XP for history
    const weekStart = getWeekStart(new Date());
    const analytics = await UserAnalytics.findOne({ userId: userObjId });

    let weeklyXPHistory = analytics?.weeklyXPHistory ?? [];

    // Weekly buckets accumulate this event's award, not the lifetime total.
    const weekIndex = weeklyXPHistory.findIndex(
      (w) => w.weekStart.getTime() === weekStart.getTime()
    );

    if (weekIndex >= 0) {
      weeklyXPHistory[weekIndex].xp += xpAwarded;
    } else {
      weeklyXPHistory.push({ weekStart, xp: xpAwarded });
    }

    // Keep only last 12 weeks
    if (weeklyXPHistory.length > 12) {
      weeklyXPHistory = weeklyXPHistory
        .sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime())
        .slice(0, 12);
    }

    // Calculate weekly consistency score
    const activeWeeks = weeklyXPHistory.filter((w) => w.xp > 0).length;
    const weeklyConsistencyScore = Math.round((activeWeeks / 12) * 100);

    await UserAnalytics.findOneAndUpdate(
      { userId: userObjId },
      {
        $set: {
          totalXp,
          currentLevel,
          dsaSolveCount,
          weeklyXPHistory,
          weeklyConsistencyScore,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    logger.warn('[xp] Failed to sync UserAnalytics', { error: err, userId });
  }
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday as first day
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
