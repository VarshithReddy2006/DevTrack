import { UserQuestProgress } from '../../db/models/userQuestProgress.model.js';
import { questObjectId, questError, questTransaction } from '../quests/questEngine.service.js';
import { writeOutboxEvent } from '../../shared/events/outbox.js';
// src/modules/xp/processor.ts — XP processing engine with idempotency
// Processes XP events, persists transactions, aggregates UserXp state.
// All XP awards MUST flow through this module — no direct UserXp writes elsewhere.

import { Types, type ClientSession } from 'mongoose';
import { UserXp, XpTransaction, UserAnalytics, Mission, FocusSession, type IUserXp } from '../../db/models/index.js';
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
import { getMissionCompletionContext } from '../missions/missionCompletionContext.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { unifiedRuntimeStateService } from '../runtime-state/unifiedRuntimeState.service.js';
import { computeActiveSec, decideFocusXp } from '../activity/focusXpDecision.js';
import { ensureUserXp, readFocusXpForDay } from './focusXpLedger.js';
import { enqueueLeagueScore } from '../leagues/workers/leagueScore.worker.js';

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

export async function processFocusSessionXp(userId: string, sessionId: string): Promise<XpProcessingResult> {
  return applyXpEvent({ userId, sourceType: 'focus_session', sourceId: sessionId });
}

// Internal mission entry point: callers supply identity, never a reward amount.
// Retain the existing manual/mission_<id> ledger key, including historical zeros.
export async function processMissionReward(userId: string, missionId: string, focusSessionId?: string): Promise<XpProcessingResult> {
  const completionCtx = !focusSessionId ? getMissionCompletionContext() : undefined;
  const mission = await Mission.findOne({
    _id: new Types.ObjectId(missionId),
    userId: new Types.ObjectId(userId),
    status: 'completed',
    ...(focusSessionId
      ? { completedByFocusSessionId: focusSessionId, $expr: { $lte: ['$completedAt', '$expiresAt'] } }
      : { expiresAt: { $gte: new Date() } }),
  }).session(completionCtx?.session ?? null).lean();

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
  const completionCtx = sourceType === 'manual' && missionReward !== undefined
    ? getMissionCompletionContext()
    : undefined;
  const activeSession = completionCtx?.session;

  const scheduleOrRun = async (fn: () => Promise<void>): Promise<void> => {
    if (completionCtx) {
      completionCtx.postCommit.push(fn);
    } else {
      await fn();
    }
  };

  // ── Step 1: Check idempotency — reject duplicate awards ─────────────────
  const existingTransaction = await XpTransaction.findOne({ userId: userObjId, sourceType, sourceId })
    .session(activeSession ?? null);
  if (existingTransaction) {
    logger.debug('[xp] Duplicate XP event rejected', {
      event: 'xp_duplicate_rejected',
      userId,
      sourceType,
      sourceId,
      requestId,
    });
    // Reconcile/repair UserAnalytics if it failed or was left behind
    await scheduleOrRun(async () => {
      const analytics = await UserAnalytics.findOne({ userId: userObjId });
      if (!analytics || analytics.totalXp < existingTransaction.newTotalXp) {
        await repairUserAnalytics(userId);
      }
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
  const baseAward = missionReward ?? calculateXpAward(sourceType, difficulty, metadata);
  if (!Number.isSafeInteger(baseAward) || baseAward < 0) throw new Error('XP award must be a nonnegative safe integer');

  // Establish the unique aggregate outside standalone transactions. When participating in
  // an outer mission-completion transaction, initialize within that session only if absent.
  if (!activeSession) {
    await ensureUserXp(userObjId);
  }
  const activityIncrements: Record<string, number> = {};
  if (sourceType === 'dsa_accepted' && difficulty) {
    activityIncrements['lifetimeStats.totalProblemsSolved'] = 1;
    if (difficulty === 'easy') activityIncrements['lifetimeStats.easySolved'] = 1;
    if (difficulty === 'medium') activityIncrements['lifetimeStats.mediumSolved'] = 1;
    if (difficulty === 'hard') activityIncrements['lifetimeStats.hardSolved'] = 1;
  }
  if (sourceType === 'dsa_contest') activityIncrements['lifetimeStats.totalContests'] = 1;
  if (sourceType === 'daily_streak') activityIncrements['lifetimeStats.dailyStreaks'] = 1;
  if (sourceType === 'sync_completed') activityIncrements['lifetimeStats.totalSyncs'] = 1;

  const executeXpUpdate = async (session: ClientSession): Promise<XpProcessingResult> => {
    const duplicate = await XpTransaction.findOne({ userId: userObjId, sourceType, sourceId }).session(session);
    if (duplicate) return duplicateResult(duplicate);
    let userXp = await UserXp.findOne({ userId: userObjId }).session(session);
    if (!userXp && activeSession) {
      await UserXp.updateOne(
        { userId: userObjId },
        { $setOnInsert: { userId: userObjId } },
        { upsert: true, session }
      );
      userXp = await UserXp.findOne({ userId: userObjId }).session(session);
    }
    if (!userXp) throw new Error('XP aggregate missing');
    const previousTotalXp = userXp.totalXp;
    const levelBefore = calculateLevel(previousTotalXp);
    let xpAwarded = baseAward;
    let ledgerMetadata = metadata;
    if (sourceType === 'focus_session') {
      const legacySessionId = /^focus_([a-f0-9]{24})$/.exec(sourceId)?.[1];
      const sessionId = legacySessionId ?? (/^[a-f0-9]{24}$/.test(sourceId) ? sourceId : undefined);
      const focus = sessionId && await FocusSession.findOne({
        _id: new Types.ObjectId(sessionId), userId: userObjId, status: 'completed',
      }).session(session).lean();

      xpAwarded = 0;
      if (focus && focus.completedAt) {
        const completionDay = focus.completedAt.toISOString().slice(0, 10);
        if (!legacySessionId) {
          xpAwarded = focus.xp?.amount ?? 0;
        } else if (!focus.xp) {
          // Prefixed jobs already in Redis settle through the legacy ledger.
          const prior = await readFocusXpForDay(userObjId, focus.completedAt, session);
          xpAwarded = decideFocusXp({
            plannedSec: focus.plannedDurationMinutes * 60,
            activeSec: computeActiveSec(focus.activeDurationMs),
            coveredHeartbeatIntervals: focus.coveredHeartbeatIntervals ?? 0,
          }, prior).xpAmount;
        }
        ledgerMetadata = { focusCompletionDay: completionDay };
      }
      if (xpAwarded === 0) {
        return { awarded: false, xpAwarded: 0, duplicate: false, levelBefore, levelAfter: levelBefore,
          leveledUp: false, newTotalXp: previousTotalXp };
      }
    }

    const newTotalXp = previousTotalXp + xpAwarded;
    if (!Number.isSafeInteger(newTotalXp)) throw new Error('XP award would produce an unsafe XP total');
    const levelAfter = calculateLevel(newTotalXp);
    await UserXp.updateOne({ _id: userXp._id }, {
      $inc: { ...activityIncrements, totalXp: xpAwarded, 'lifetimeStats.totalXpEarned': xpAwarded },
      $set: { currentLevel: levelAfter, xpToNextLevel: xpToNextLevel(newTotalXp, levelAfter), lastXpGainedAt: new Date() },
    }, { session });
    await XpTransaction.create([{
      userId: userObjId, sourceType, sourceId, xpAwarded,
      previousTotalXp, newTotalXp, levelBefore, levelAfter, metadata: ledgerMetadata ?? {},
    }], { session });
    return { awarded: true, xpAwarded, duplicate: false, levelBefore, levelAfter,
      leveledUp: levelAfter > levelBefore, newTotalXp };
  };

  let transition: XpProcessingResult;
  if (activeSession) {
    transition = await executeXpUpdate(activeSession);
  } else {
    try {
      // The driver retries transient write conflicts and ambiguous commits.
      // No external effects run inside a callback that can be retried.
      transition = await UserXp.db.transaction(executeXpUpdate, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // A competing idempotency-key insertion aborts this whole transaction,
      // including its aggregate increment. Return only a committed matching row.
      const duplicate = await XpTransaction.findOne({ userId: userObjId, sourceType, sourceId });
      if (!duplicate) throw error;
      return duplicateResult(duplicate);
    }
  }
  if (transition.duplicate) {
    await scheduleOrRun(async () => {
      const analytics = await UserAnalytics.findOne({ userId: userObjId });
      if (!analytics || analytics.totalXp < transition.newTotalXp) {
        await repairUserAnalytics(userId);
      }
    });
    return transition;
  }
  if (!transition.awarded) return transition;
  const { xpAwarded, levelBefore, levelAfter, leveledUp, newTotalXp } = transition;

  await scheduleOrRun(async () => {
    // ── Step 7: Sync to UserAnalytics ────────────────────────────────────────
    await syncUserAnalytics(userId, newTotalXp, xpAwarded, levelAfter, sourceType);

    // ── Step 8: Cache invalidation ───────────────────────────────────────────
    try {
      await cacheManager.invalidateAllUserCache(userId);
    } catch (err) {
      logger.warn('[xp] Cache invalidation failed (non-fatal)', { error: err });
    }

    // Publish every crossed threshold, and only after the transaction commits.
    eventBus.emitXpUpdated(userId, newTotalXp, xpAwarded, levelAfter, xpToNextLevel(newTotalXp, levelAfter));
    for (let level = levelBefore + 1; level <= levelAfter; level++) {
      eventBus.emitLevelUp(userId, level, newTotalXp);
    }
    // ── Weekly leagues: hand the committed award to the league score worker ──
    if (xpAwarded > 0) {
      try {
        await enqueueLeagueScore({ userId, sourceType, sourceId, xpAwarded, occurredAt: new Date().toISOString(), requestId });
      } catch (err) {
        logger.warn('[xp] League score enqueue failed (non-fatal)', { error: err });
      }
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
    case 'sync_completed': {
      if (typeof metadata?.deltaSolved === 'number') {
        const delta = metadata.deltaSolved;
        if (delta <= 0) return 0;
        if (metadata.isFirstSync) return XP_REWARDS.syncCompleted;
        return delta * XP_REWARDS.syncCompleted;
      }
      return XP_REWARDS.syncCompleted;
    }
    case 'challenge_completed': return typeof metadata?.xpReward === 'number' ? metadata.xpReward : 35;
    case 'revision_review': return XP_REWARDS.revisionReview;
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

    // Get authoritative state from UserXp aggregate
    const userXp = await UserXp.findOne({ userId: userObjId });
    const safeTotalXp = Math.max(totalXp, userXp?.totalXp ?? 0);
    const safeCurrentLevel = Math.max(currentLevel, userXp?.currentLevel ?? 1);
    const dsaSolveCount = userXp?.lifetimeStats?.totalProblemsSolved ?? 0;

    const weekStart = getWeekStart(new Date());
    const analytics = await UserAnalytics.findOne({ userId: userObjId });

    let weeklyXPHistory = analytics?.weeklyXPHistory ? [...analytics.weeklyXPHistory] : [];

    // Query committed transactions for the current week to guarantee consistency under concurrent writes
    const weekTransactions = await XpTransaction.find({
      userId: userObjId,
      createdAt: { $gte: weekStart },
    });
    const committedWeekXp = weekTransactions.reduce((sum, tx) => sum + tx.xpAwarded, 0);

    const weekIndex = weeklyXPHistory.findIndex(
      (w) => w.weekStart.getTime() === weekStart.getTime()
    );

    if (weekIndex >= 0) {
      weeklyXPHistory[weekIndex].xp = Math.max(weeklyXPHistory[weekIndex].xp + xpAwarded, committedWeekXp);
    } else {
      weeklyXPHistory.push({ weekStart, xp: Math.max(xpAwarded, committedWeekXp) });
    }

    if (weeklyXPHistory.length > 12) {
      weeklyXPHistory = weeklyXPHistory
        .sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime())
        .slice(0, 12);
    }

    const activeWeeks = weeklyXPHistory.filter((w) => w.xp > 0).length;
    const weeklyConsistencyScore = Math.round((activeWeeks / 12) * 100);

    await UserAnalytics.findOneAndUpdate(
      { userId: userObjId },
      {
        $max: {
          totalXp: safeTotalXp,
          currentLevel: safeCurrentLevel,
        },
        $set: {
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

async function repairUserAnalytics(userId: string): Promise<void> {
  try {
    const userObjId = new Types.ObjectId(userId);
    const userXp = await UserXp.findOne({ userId: userObjId });
    if (!userXp) return;

    const existingAnalytics = await UserAnalytics.findOne({ userId: userObjId });
    const transactions = await XpTransaction.find({ userId: userObjId }).sort({ createdAt: -1 });

    const weekMap = new Map<number, { weekStart: Date; xp: number }>();
    for (const tx of transactions) {
      const ws = getWeekStart(new Date(tx.createdAt));
      const key = ws.getTime();
      const existing = weekMap.get(key);
      if (existing) {
        existing.xp += tx.xpAwarded;
      } else {
        weekMap.set(key, { weekStart: ws, xp: tx.xpAwarded });
      }
    }

    if (existingAnalytics?.weeklyXPHistory) {
      for (const bucket of existingAnalytics.weeklyXPHistory) {
        const key = bucket.weekStart.getTime();
        if (!weekMap.has(key)) {
          weekMap.set(key, { weekStart: bucket.weekStart, xp: bucket.xp });
        }
      }
    }

    const weeklyXPHistory = Array.from(weekMap.values())
      .sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime())
      .slice(0, 12);

    const activeWeeks = weeklyXPHistory.filter((w) => w.xp > 0).length;
    const weeklyConsistencyScore = Math.round((activeWeeks / 12) * 100);
    const dsaSolveCount = userXp.lifetimeStats?.totalProblemsSolved ?? 0;

    await UserAnalytics.findOneAndUpdate(
      { userId: userObjId },
      {
        $max: {
          totalXp: userXp.totalXp,
          currentLevel: userXp.currentLevel,
        },
        $set: {
          dsaSolveCount,
          weeklyXPHistory,
          weeklyConsistencyScore,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    logger.warn('[xp] Failed to repair UserAnalytics', { error: err, userId });
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

/** Claim a persisted, owned quest reward atomically with the XP ledger. */
export async function processQuestReward(userId: string, progressId: string, now = new Date()) {
  questObjectId.parse(userId);
  questObjectId.parse(progressId);
  await ensureUserXp(new Types.ObjectId(userId));
  return questTransaction(async session => {
    const progress = await UserQuestProgress.findOne({ _id: progressId, userId }).session(session);
    if (!progress) throw questError(404, 'Quest not found');
    const sourceId = 'quest_' + progressId;
    const existing = await XpTransaction.findOne({ userId, sourceType: 'manual', sourceId }).session(session).lean();
    if (progress.claimed) {
      if (!existing) throw new Error('Claimed quest is missing its reward ledger');
      const wallet = await UserXp.findOne({ userId }).session(session).lean();
      return { questId: progressId, claimed: true, duplicate: true, xpReward: progress.xpReward,
        trophyReward: progress.trophyReward, totalXp: wallet!.totalXp, leagueTrophies: wallet!.leagueTrophies ?? 0 };
    }
    if (existing) throw new Error('Unclaimed quest already has a reward ledger');
    if (!progress.completed || progress.currentCount < progress.targetCount || !progress.completedAt
      || progress.completedAt >= progress.expiresAt || progress.startsAt > now || progress.expiresAt <= now) {
      throw questError(409, 'Quest is incomplete or expired');
    }
    if (!Number.isSafeInteger(progress.xpReward) || progress.xpReward <= 0 || progress.xpReward > 10_000
      || !Number.isSafeInteger(progress.trophyReward) || progress.trophyReward <= 0 || progress.trophyReward > 1000) {
      throw new Error('Invalid persisted quest reward');
    }
    const wallet = await UserXp.findOne({ userId }).session(session);
    if (!wallet) throw new Error('XP aggregate missing');
    const previousTotalXp = wallet.totalXp;
    const newTotalXp = previousTotalXp + progress.xpReward;
    const trophies = (wallet.leagueTrophies ?? 0) + progress.trophyReward;
    if (!Number.isSafeInteger(newTotalXp) || !Number.isSafeInteger(trophies)) throw new Error('Unsafe quest reward aggregate');
    const levelBefore = calculateLevel(previousTotalXp);
    const levelAfter = calculateLevel(newTotalXp);
    const claimedProgress = await UserQuestProgress.findOneAndUpdate(
      { _id: progressId, userId, claimed: false },
      { $set: { claimed: true, claimedAt: now } },
      { session, new: true },
    );
    if (!claimedProgress) {
      const currentWallet = await UserXp.findOne({ userId }).session(session).lean();
      return { questId: progressId, claimed: true, duplicate: true, xpReward: progress.xpReward,
        trophyReward: progress.trophyReward, totalXp: currentWallet!.totalXp, leagueTrophies: currentWallet!.leagueTrophies ?? 0 };
    }
    await XpTransaction.create([{
      userId, sourceType: 'manual', sourceId, xpAwarded: progress.xpReward,
      previousTotalXp, newTotalXp, levelBefore, levelAfter,
      metadata: { questId: progressId, periodKey: progress.periodKey, leagueTrophies: progress.trophyReward },
    }], { session });
    await UserXp.updateOne({ _id: wallet._id }, {
      $inc: { totalXp: progress.xpReward, leagueTrophies: progress.trophyReward, 'lifetimeStats.totalXpEarned': progress.xpReward },
      $set: { currentLevel: levelAfter, xpToNextLevel: xpToNextLevel(newTotalXp, levelAfter), lastXpGainedAt: now },
    }, { session });
    await UserAnalytics.updateOne({ userId }, { $max: { totalXp: newTotalXp, currentLevel: levelAfter } }, { upsert: true, session });
    await writeOutboxEvent(session, { type: 'quest.claimed', aggregateType: 'UserQuestProgress', aggregateId: progressId,
      userId, payload: { progressId } });
    return { questId: progressId, claimed: true, duplicate: false, xpReward: progress.xpReward,
      trophyReward: progress.trophyReward, totalXp: newTotalXp, leagueTrophies: trophies };
  });
}

/** Retryable post-commit projection/delivery; balances were already committed. */
export async function reconcileQuestReward(userId: string, progressId: string) {
  const sourceId = 'quest_' + progressId;
  const award = await XpTransaction.findOne({ userId, sourceType: 'manual', sourceId }).lean();
  if (!award || award.metadata?.questId !== progressId) throw new Error('Quest reward ledger missing');
  await repairUserAnalytics(userId);
  await cacheManager.invalidateAllUserCache(userId);
  await enqueueLeagueScore({ userId, sourceType: 'manual', sourceId, xpAwarded: award.xpAwarded,
    occurredAt: award.createdAt.toISOString() });
  const wallet = await UserXp.findOne({ userId }).lean();
  if (!wallet) throw new Error('XP aggregate missing');
  await eventBus.publishEnvelope(userId, 'xp_updated', { totalXp: wallet.totalXp, gainedXp: award.xpAwarded,
    currentLevel: wallet.currentLevel, nextLevelXp: wallet.xpToNextLevel, sourceType: 'quest' });
  for (let level = award.levelBefore + 1; level <= award.levelAfter; level++) {
    await eventBus.publishEnvelope(userId, 'level_up', { newLevel: level, totalXp: wallet.totalXp, previousLevel: level - 1 });
  }
  await unifiedRuntimeStateService.updateFromEvent({ eventId: sourceId, eventType: 'xp_awarded', userId, timestamp: new Date(),
    data: { xpAwarded: award.xpAwarded, newTotalXp: wallet.totalXp, levelBefore: wallet.currentLevel, levelAfter: wallet.currentLevel,
      xpToNextLevel: wallet.xpToNextLevel } });
}
