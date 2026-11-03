// src/modules/streak/streak.service.ts — Streak Engine V2
// Timezone-safe streak computation with anti-cheat, deduplication, and freeze support.

import { Types } from 'mongoose';
import { User, UserStreakLog, UserAnalytics, type StreakType, type IUserStreakLog } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { eventBus } from '../../shared/sse/index.js';
import { getXpProcessingQueue } from '../../shared/jobs/index.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { unifiedRuntimeStateService } from '../runtime-state/unifiedRuntimeState.service.js';

const STREAK_FREEZE_DAYS = 1; // Freeze grants 1 day of protection
const MAX_VALID_AGE_DAYS = 2; // Reject activity older than 2 days (anti-cheat)
const ALL_STREAK_TYPES: StreakType[] = ['dsa', 'github', 'focus', 'unified'];

export interface RecordActivityPayload {
  userId: string;
  streakType: StreakType;
  source: string; // submissionId, commit SHA, etc.
  activityDate?: Date;
  timezone?: string;
  metadata?: Record<string, unknown>;
}

export interface StreakStatus {
  currentStreak: number;
  bestStreak: number;
  streakType: StreakType;
  lastActiveDate: Date | null;
  isActiveToday: boolean;
  streakFreezeUntil: Date | null;
}

// ─── Core streak recorder ─────────────────────────────────────────────────────

export async function recordActivity(payload: RecordActivityPayload): Promise<void> {
  const { userId, streakType, source, activityDate = new Date(), timezone = 'UTC', metadata = {} } = payload;
  const userObjId = new Types.ObjectId(userId);

  // ── Step 1: Normalize date to user's timezone midnight ───────────────────
  const normalizedDate = normalizeToUserDate(activityDate, timezone);

  // ── Step 2: Anti-cheat validation ─────────────────────────────────────────
  const now = new Date();
  const daysDiff = Math.floor((now.getTime() - normalizedDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysDiff > MAX_VALID_AGE_DAYS) {
    logger.warn('[streak] Activity rejected: too old', {
      event: 'streak_rejected_old',
      userId,
      streakType,
      activityDate: normalizedDate.toISOString(),
      daysDiff,
    });
    return;
  }

  // ── Step 3: Deduplication ────────────────────────────────────────────────
  const existingLog = await UserStreakLog.findOne({
    userId: userObjId,
    date: normalizedDate,
    streakType,
  });

  if (existingLog) {
    // Check if source already recorded
    if (existingLog.sources.includes(source)) {
      logger.debug('[streak] Duplicate source ignored', {
        event: 'streak_duplicate_source',
        userId,
        streakType,
        source,
      });
      return;
    }

    // Add new source to existing log
    await UserStreakLog.findByIdAndUpdate(existingLog._id, {
      $inc: { activityCount: 1 },
      $addToSet: { sources: source },
    });
    logger.debug('[streak] Source added to existing log', {
      event: 'streak_source_added',
      userId,
      streakType,
      source,
    });
  } else {
    // Create new log
    await UserStreakLog.create({
      userId: userObjId,
      date: normalizedDate,
      streakType,
      activityCount: 1,
      sources: [source],
      timezone,
      metadata,
    });
    logger.debug('[streak] New activity logged', {
      event: 'streak_new_log',
      userId,
      streakType,
      date: normalizedDate.toISOString(),
    });
  }

  // ── Step 4: Recalculate streak ────────────────────────────────────────────
  await recalculateStreak(userId, streakType);
}

// ─── Recalculation ─────────────────────────────────────────────────────────

export async function recalculateStreak(userId: string, streakType: StreakType): Promise<StreakStatus> {
  const userObjId = new Types.ObjectId(userId);
  const timezone = await getUserTimezone(userId);

  // Get all logs for this user and streak type, sorted by date descending.
  // Nothing writes 'unified' logs, so 'unified' is the union of every type's days.
  const isUnified = streakType === 'unified';
  const logs = await UserStreakLog.find({
    userId: userObjId,
    streakType: isUnified ? { $in: ALL_STREAK_TYPES } : streakType,
  })
    .sort({ date: -1 })
    .limit(365 * (isUnified ? ALL_STREAK_TYPES.length : 1)); // Cap at 1 year of days for performance

  if (logs.length === 0) {
    // currentStreak is one field per user. Only reset it when the user has no
    // activity at all; a single type without logs must not zero the others' streak.
    if (isUnified) return resetStreak(userId, streakType);
    const existing = await UserAnalytics.findOne({ userId: userObjId }).lean();
    return {
      currentStreak: 0,
      bestStreak: existing?.bestStreak ?? 0,
      streakType,
      lastActiveDate: null,
      isActiveToday: false,
      streakFreezeUntil: existing?.streakFreezeUntil ?? null,
    };
  }

  // Fetch analytics for freeze data before calculating streak
  const analytics = await UserAnalytics.findOne({ userId: userObjId });

  // Calculate current streak (freeze-aware)
  const { currentStreak, streakDays, freezeConsumed } = calculateCurrentStreak(
    logs, timezone, analytics?.streakFreezeUntil ?? null
  );

  // Update best streak if current exceeds it
  const bestStreak = Math.max(analytics?.bestStreak ?? 0, currentStreak);

  // Determine if streak is active today
  const today = normalizeToUserDate(new Date(), timezone);
  const isActiveToday = streakDays.length > 0 &&
    streakDays[0].getTime() === today.getTime();

  // Build streak status
  const status: StreakStatus = {
    currentStreak,
    bestStreak,
    streakType,
    lastActiveDate: streakDays[0] ?? null,
    isActiveToday,
    streakFreezeUntil: freezeConsumed ? null : (analytics?.streakFreezeUntil ?? null),
  };

  // ── Step 5: Update UserAnalytics ─────────────────────────────────────────
  const update: Record<string, unknown> = {
    currentStreak,
    bestStreak,
    currentStreakType: streakType,
    lastActiveDate: streakDays[0] ?? null,
    updatedAt: new Date(),
    computedAt: new Date(),
  };

  // Consume streak freeze if it was used during calculation
  if (freezeConsumed) {
    update.streakFreezeUntil = null;
  }

  // Handle streak freeze expiry
  if (analytics?.streakFreezeUntil && analytics.streakFreezeUntil < new Date()) {
    update.streakFreezeUntil = null;
  }

  await UserAnalytics.findOneAndUpdate(
    { userId: userObjId },
    { $set: update },
    { upsert: true, new: true }
  );

  // ── Step 6: Emit streak milestone events and trigger XP ───────────────
  const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100, 365];
  const previousStreak = analytics?.currentStreak ?? 0;
  const hitMilestone = STREAK_MILESTONES.find(
    (m) => currentStreak >= m && previousStreak < m
  );

  if (hitMilestone) {
    eventBus.emitStreakMilestone(userId, currentStreak, streakType);

    // Trigger streak bonus XP via queue. The ledger key is the milestone plus the
    // day this streak started, so recalculating the same streak again (or from a
    // different type) hits the XpTransaction unique index instead of paying twice.
    try {
      const queue = getXpProcessingQueue();
      const streakStart = streakDays[streakDays.length - 1].toISOString().split('T')[0];
      await queue.add('streak-milestone', {
        userId,
        sourceType: 'daily_streak',
        sourceId: `streak_${hitMilestone}_${streakStart}`,
        metadata: { streakDays: currentStreak, streakType },
      });
      logger.info('[streak] XP bonus queued for milestone', {
        event: 'streak_xp_queued',
        userId,
        streakDays: currentStreak,
      });
    } catch (err) {
      logger.warn('[streak] Failed to queue XP bonus', { error: err });
    }
  }

  // ── Step 7: Emit streak-at-risk if applicable ──────────────────────────
  if (currentStreak > 0 && !isActiveToday && !status.streakFreezeUntil) {
    const now = new Date();
    const localHourFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false,
    });
    const localHour = parseInt(localHourFormatter.format(now), 10);
    const hoursRemaining = Math.max(0, 24 - localHour);

    eventBus.emitStreakAtRisk(userId, currentStreak, hoursRemaining);
  }

  // ── Step 8: Cache invalidation ─────────────────────────────────────────
  try {
    await cacheManager.invalidateUserStreak(userId);
    await cacheManager.invalidateDashboard(userId);
  } catch (err) {
    logger.warn('[streak] Cache invalidation failed (non-fatal)', { error: err });
  }

  // ── Step 9: Runtime state sync ──────────────────────────────────────────
  try {
    await unifiedRuntimeStateService.updateFromEvent({
      eventId: `streak_${streakType}_${Date.now()}`,
      eventType: 'streak_updated',
      userId,
      timestamp: new Date(),
      data: status as unknown as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn('[streak] Runtime state sync failed (non-fatal)', { error: err });
  }

  logger.info('[streak] Recalculated', {
    event: 'streak_recalculated',
    userId,
    streakType,
    currentStreak,
    bestStreak,
    isActiveToday,
    freezeConsumed,
  });

  return status;
}

function calculateCurrentStreak(
  logs: IUserStreakLog[],
  timezone: string,
  streakFreezeUntil: Date | null
): { currentStreak: number; streakDays: Date[]; freezeConsumed: boolean } {
  const streakDays: Date[] = [];
  let streakCount = 0;
  let freezeConsumed = false;

  // Group by date
  const dateMap = new Map<string, number>();
  for (const log of logs) {
    const dateKey = log.date.toISOString().split('T')[0];
    const existing = dateMap.get(dateKey) ?? 0;
    dateMap.set(dateKey, existing + log.activityCount);
  }

  // Sort dates descending
  const sortedDates = Array.from(dateMap.keys()).sort().reverse();

  const today = normalizeToUserDate(new Date(), timezone);
  let expectedDate = new Date(today);

  // Determine if freeze is currently active
  const freezeActive = streakFreezeUntil !== null && streakFreezeUntil >= new Date();

  for (const dateKey of sortedDates) {
    const logDate = new Date(dateKey + 'T00:00:00.000Z');
    const daysDiff = Math.round((expectedDate.getTime() - logDate.getTime()) / (1000 * 60 * 60 * 24));

    // Today may still be incomplete, but that grace applies only to the first log.
    const initialGraceDays = streakCount === 0 ? 1 : 0;
    if (daysDiff > initialGraceDays) {
      // Gap detected — check if freeze covers it
      if (freezeActive && !freezeConsumed && daysDiff === initialGraceDays + STREAK_FREEZE_DAYS) {
        // Freeze covers exactly one missed day — consume it and continue
        freezeConsumed = true;
      } else {
        // No freeze available or gap too large — streak breaks
        break;
      }
    }

    // Valid streak day
    streakDays.push(logDate);
    streakCount++;
    expectedDate = new Date(logDate.getTime() - 24 * 60 * 60 * 1000);
  }

  return { currentStreak: streakCount, streakDays, freezeConsumed };
}

// ─── Reset streak ────────────────────────────────────────────────────────────

async function resetStreak(userId: string, streakType: StreakType): Promise<StreakStatus> {
  await UserAnalytics.findOneAndUpdate(
    { userId: new Types.ObjectId(userId) },
    {
      $set: {
        currentStreak: 0,
        currentStreakType: streakType,
        lastActiveDate: null,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  return {
    currentStreak: 0,
    bestStreak: 0,
    streakType,
    lastActiveDate: null,
    isActiveToday: false,
    streakFreezeUntil: null,
  };
}

// ─── Freeze management ─────────────────────────────────────────────────────

export async function activateStreakFreeze(userId: string): Promise<void> {
  const freezeUntil = new Date();
  freezeUntil.setDate(freezeUntil.getDate() + STREAK_FREEZE_DAYS);

  await UserAnalytics.findOneAndUpdate(
    { userId: new Types.ObjectId(userId) },
    {
      $set: {
        streakFreezeUntil: freezeUntil,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  logger.info('[streak] Freeze activated', {
    event: 'streak_freeze_activated',
    userId,
    freezeUntil,
  });
}

// ─── Unified streak computation ────────────────────────────────────────────

export async function getUnifiedStreak(userId: string): Promise<StreakStatus> {
  const userObjId = new Types.ObjectId(userId);
  const timezone = await getUserTimezone(userId);
  const today = normalizeToUserDate(new Date(), timezone);

  // Check all three streak types for today
  const [dsaLog, githubLog] = await Promise.all([
    UserStreakLog.findOne({
      userId: userObjId,
      date: today,
      streakType: 'dsa',
    }),
    UserStreakLog.findOne({
      userId: userObjId,
      date: today,
      streakType: 'github',
    }),
  ]);

  // Determine which streak type to use for unified
  const analytics = await UserAnalytics.findOne({ userId: userObjId });

  if (dsaLog || githubLog) {
    // At least one activity today - update unified streak
    await recalculateStreak(userId, 'unified');
  }

  return {
    currentStreak: analytics?.currentStreak ?? 0,
    bestStreak: analytics?.bestStreak ?? 0,
    streakType: 'unified',
    lastActiveDate: analytics?.lastActiveDate ?? null,
    isActiveToday: !!(dsaLog || githubLog),
    streakFreezeUntil: analytics?.streakFreezeUntil ?? null,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizeToUserDate(date: Date, timezone: string): Date {
  // Get the calendar date string in the user's timezone using Intl API
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const dateStr = formatter.format(date); // "YYYY-MM-DD"
    return new Date(dateStr + 'T00:00:00.000Z');
  } catch (err) {
    logger.debug('[streak] Invalid timezone, using UTC fallback', { timezone, error: err instanceof Error ? err.message : String(err) });
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}

async function getUserTimezone(userId: string): Promise<string> {
  try {
    const user = await User.findById(userId).select('timezone').lean();
    return (user as Record<string, unknown>)?.timezone as string || 'UTC';
  } catch (err) {
    logger.warn('[streak] Failed to fetch user timezone', { userId, error: err instanceof Error ? err.message : String(err) });
    return 'UTC';
  }
}

// ─── Streak status getter ──────────────────────────────────────────────────

export async function getStreakStatus(userId: string, streakType?: StreakType): Promise<StreakStatus> {
  if (streakType) {
    return recalculateStreak(userId, streakType);
  }
  return getUnifiedStreak(userId);
}

// ─── Streak history getter ──────────────────────────────────────────────────

export async function getStreakHistory(userId: string): Promise<any[]> {
  const userObjId = new Types.ObjectId(userId);
  const timezone = await getUserTimezone(userId);
  
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const normalizedThirtyDaysAgo = normalizeToUserDate(thirtyDaysAgo, timezone);

  // Group by date across all streak types for simplicity, or just return unified
  const logs = await UserStreakLog.find({ 
    userId: userObjId,
    date: { $gte: normalizedThirtyDaysAgo }
  }).sort({ date: 1 });

  // Map to the history format
  const historyMap = new Map<string, { count: number; active: boolean }>();
  
  for (const log of logs) {
    const dateStr = log.date.toISOString().split('T')[0];
    const current = historyMap.get(dateStr) || { count: 0, active: false };
    historyMap.set(dateStr, {
      count: current.count + log.activityCount,
      active: true
    });
  }

  // Fill in empty days
  const history = [];
  const currentDate = new Date(normalizedThirtyDaysAgo);
  const today = normalizeToUserDate(new Date(), timezone);
  
  while (currentDate <= today) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const data = historyMap.get(dateStr) || { count: 0, active: false };
    history.push({
      date: dateStr,
      count: data.count,
      active: data.active
    });
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return history;
}
