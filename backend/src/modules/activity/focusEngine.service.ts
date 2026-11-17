// ============================================================================
// focusEngine.service.ts — Focus Engine Backend Service
// ============================================================================
// Manages deep work session persistence, quality scoring, and session history.
// ============================================================================

import { Types, type ClientSession, type HydratedDocument } from 'mongoose';
import { FocusSession, UnifiedRuntimeState, User, UserXp, type IFocusSession } from '../../db/models/index.js';
import { runInTransaction } from '../../db/transaction.js';
import { logger } from '../../shared/logger.js';
import { writeOutboxEvent } from '../../shared/events/outbox.js';
import { focusSessionCompletedV1Schema } from '../../shared/events/eventContract.js';
import { getTraceMetadata } from '../../shared/tracing/tracing.js';
import { eventBus } from '../../shared/sse/index.js';
import { ensureUserXp, readFocusXpForDay } from '../xp/focusXpLedger.js';
import { computeActiveSec, decideFocusXp, FOCUS_HEARTBEAT_SECONDS } from './focusXpDecision.js';

export interface FocusSessionResult {
  sessionId: string;
  qualityScore: number;
  actualDuration: number;
  plannedDurationMinutes: number;
  coveredHeartbeatIntervals: number;
  activeDurationMs: number;
  session: HydratedDocument<IFocusSession>;
  replayed: boolean;
}

function completionResult(session: HydratedDocument<IFocusSession>, replayed: boolean): FocusSessionResult {
  return {
    sessionId: String(session._id),
    qualityScore: session.focusQualityScore,
    actualDuration: session.actualDurationMinutes,
    plannedDurationMinutes: session.plannedDurationMinutes,
    coveredHeartbeatIntervals: session.coveredHeartbeatIntervals ?? 0,
    activeDurationMs: session.activeDurationMs,
    session,
    replayed,
  };
}

export interface FocusTiming {
  activeDurationMs: number;
  lastResumedAt: Date | null;
}

export interface FocusHistoryOptions {
  status?: 'running' | 'paused' | 'completed' | 'abandoned' | 'all';
  mode?: string;
  limit?: number;
  offset?: number;
}

export interface FocusHistoryItem {
  id: string;
  mode: string;
  status: string;
  plannedDurationMinutes: number;
  actualDurationMinutes: number;
  activeDurationMs: number;
  focusQualityScore: number | null;
  startedAt: Date;
  completedAt: Date | null;
  heartbeatCount: number;
}

export interface FocusHistoryResult {
  sessions: FocusHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface FocusSummaryResult {
  totalSessions: number;
  completedSessions: number;
  abandonedSessions: number;
  totalDurationMinutes: number;
  averageQualityScore: number;
  modeBreakdown: Record<string, { sessions: number; totalMinutes: number }>;
}

/** A running session with no sign of life for this long is considered abandoned. */
export const RUNNING_STALE_MS = 15 * 60 * 1000;
/** A paused session is given far longer, since the user may step away on purpose. */
export const PAUSED_STALE_MS = 12 * 60 * 60 * 1000;

export class FocusSessionConflictError extends Error {
  statusCode = 409;
  code = 'FOCUS_SESSION_ALREADY_OPEN';
  data?: any;
  constructor(existingSession?: any) {
    super('A focus session is already open');
    this.name = 'FocusSessionConflictError';
    this.code = 'FOCUS_SESSION_ALREADY_OPEN';
    this.data = existingSession;
  }
}

export function computeActiveDuration(session: {
  startedAt: Date;
  status?: string;
  pauses?: Array<{ startedAt: Date; endedAt?: Date | null }>;
  now?: Date;
}): { activeSec: number; activeDurationMs: number } {
  const now = session.now ?? new Date();
  const startedAtMs = new Date(session.startedAt).getTime();
  const totalWallClockSec = Math.max(0, Math.floor((now.getTime() - startedAtMs) / 1000));

  let totalPausedSec = 0;
  if (Array.isArray(session.pauses)) {
    for (const pause of session.pauses) {
      const pStart = new Date(pause.startedAt).getTime();
      const pEnd = pause.endedAt ? new Date(pause.endedAt).getTime() : now.getTime();
      if (pEnd > pStart) {
        totalPausedSec += Math.floor((pEnd - pStart) / 1000);
      }
    }
  }

  const activeSec = Math.max(0, totalWallClockSec - totalPausedSec);
  return {
    activeSec,
    activeDurationMs: activeSec * 1000,
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

function staleFilter(now: Date, runningMs: number, pausedMs: number) {
  const runningCutoff = new Date(now.getTime() - runningMs);
  const pausedCutoff = new Date(now.getTime() - pausedMs);
  // Sessions written before lastHeartbeatAt existed fall back to startedAt.
  const idle = (cutoff: Date) => ({
    $or: [{ lastHeartbeatAt: { $lt: cutoff } }, { lastHeartbeatAt: { $exists: false }, startedAt: { $lt: cutoff } }],
  });
  return {
    $or: [
      { status: 'running', ...idle(runningCutoff) },
      { status: 'paused', ...idle(pausedCutoff) },
    ],
  };
}

export class FocusEngine {
  /**
   * Starts a new focus session and persists it. A user may hold only one live
   * (running or paused) session; the partial unique index enforces that even
   * for simultaneous requests, and a stale one of the user's own is reaped
   * first so an abandoned session never locks them out.
   * Throws FocusSessionConflictError (409) when another session is still live.
   */
  async startSession(
    userId: string,
    modeOrOptions?: string | { mode?: string; plannedDurationMinutes?: number; plannedSec?: number },
    durationMinutes?: number
  ): Promise<{ sessionId: string; startedAt: Date; session?: any }> {
    const userObjId = new Types.ObjectId(userId);
    await this.reapStaleSessions({ userId });

    let mode = 'deep_work';
    let plannedMin = 25;
    let plannedSec = 1500;

    if (typeof modeOrOptions === 'object' && modeOrOptions !== null) {
      mode = modeOrOptions.mode || 'deep_work';
      if (modeOrOptions.plannedSec) {
        plannedSec = modeOrOptions.plannedSec;
        plannedMin = Math.round(plannedSec / 60);
      } else if (modeOrOptions.plannedDurationMinutes) {
        plannedMin = modeOrOptions.plannedDurationMinutes;
        plannedSec = plannedMin * 60;
      }
    } else if (typeof modeOrOptions === 'string') {
      mode = modeOrOptions;
      plannedMin = durationMinutes ?? 25;
      plannedSec = plannedMin * 60;
    }

    const startedAt = new Date();
    try {
      const session = await FocusSession.create({
        userId: userObjId,
        mode,
        status: 'running',
        isOpen: true,
        startedAt,
        lastResumedAt: startedAt,
        lastHeartbeatAt: startedAt,
        activeDurationMs: 0,
        activeSec: 0,
        plannedDurationMinutes: plannedMin,
        plannedSec,
        pauses: [],
      });
      return { sessionId: session._id.toString(), startedAt, session };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const active = await FocusSession.findOne({
          userId: userObjId,
          isOpen: true,
        }).lean();
        throw new FocusSessionConflictError(active);
      }
      throw err;
    }
  }

  /**
   * Marks stale running/paused sessions abandoned and clears the matching
   * runtime-state context. Each session is flipped with a conditional update,
   * so concurrent or repeated runs are safe and a second run finds nothing.
   * Pass `userId` to limit it to one user (session-start self-healing).
   */
  async reapStaleSessions(
    options: { userId?: string; now?: Date; runningMs?: number; pausedMs?: number } = {}
  ): Promise<number> {
    const now = options.now ?? new Date();
    const filter = {
      ...(options.userId ? { userId: new Types.ObjectId(options.userId) } : {}),
      ...staleFilter(now, options.runningMs ?? RUNNING_STALE_MS, options.pausedMs ?? PAUSED_STALE_MS),
    };
    const candidates = await FocusSession.find(filter).select('_id').lean();
    const reaped: Types.ObjectId[] = [];
    for (const { _id } of candidates) {
      // Re-check staleness in the update itself: a heartbeat that landed after
      // the scan makes the filter miss and the session survives.
      const done = await FocusSession.findOneAndUpdate(
        { _id, ...filter },
        { $set: { status: 'abandoned', isOpen: false, completedAt: now, lastResumedAt: null } },
        { new: true }
      );
      if (done) reaped.push(done._id);
    }
    if (reaped.length) {
      await UnifiedRuntimeState.updateMany(
        { 'sessionContext.sessionId': { $in: reaped.map(String) }, 'sessionContext.isActive': true },
        { $set: { 'sessionContext.isActive': false, 'sessionContext.status': 'abandoned', 'sessionContext.lastResumedAt': null } }
      );
      logger.info('[focus] Reaped stale focus sessions', { count: reaped.length, userId: options.userId });
    }
    return reaped.length;
  }

  async pauseSession(sessionId: string, userId: string): Promise<FocusTiming | null> {
    const session = await FocusSession.findOne({ _id: new Types.ObjectId(sessionId), userId: new Types.ObjectId(userId) });
    if (!session || (session.status !== 'running' && session.status !== 'active')) return null;
    const now = new Date();
    const pauses = Array.isArray(session.pauses) ? [...session.pauses] : [];
    pauses.push({ startedAt: now, endedAt: null });

    const { activeSec, activeDurationMs } = computeActiveDuration({
      startedAt: session.startedAt,
      status: 'paused',
      pauses,
      now,
    });

    const paused = await FocusSession.findOneAndUpdate(
      { _id: session._id, userId: session.userId, status: session.status },
      { $set: { status: 'paused', pauses, activeSec, activeDurationMs, lastResumedAt: null, lastHeartbeatAt: now } },
      { new: true }
    );
    return paused ? { activeDurationMs, lastResumedAt: null } : null;
  }

  async resumeSession(sessionId: string, userId: string): Promise<FocusTiming | null> {
    const session = await FocusSession.findOne({ _id: new Types.ObjectId(sessionId), userId: new Types.ObjectId(userId) });
    if (!session || session.status !== 'paused') return null;
    const now = new Date();
    const pauses = Array.isArray(session.pauses) ? [...session.pauses] : [];
    for (const p of pauses) {
      if (!p.endedAt) p.endedAt = now;
    }

    const { activeSec, activeDurationMs } = computeActiveDuration({
      startedAt: session.startedAt,
      status: 'running',
      pauses,
      now,
    });

    const resumed = await FocusSession.findOneAndUpdate(
      { _id: session._id, userId: session.userId, status: 'paused' },
      { $set: { status: 'running', pauses, activeSec, activeDurationMs, lastResumedAt: now, lastHeartbeatAt: now } },
      { new: true }
    );
    return resumed ? { activeDurationMs: resumed.activeDurationMs ?? 0, lastResumedAt: now } : null;
  }

  /**
   * Records a heartbeat to verify active focus.
   */
  async recordHeartbeat(
    sessionId: string,
    userId: string,
    enforceThrottle = false
  ): Promise<{ success: boolean; throttled?: boolean; session?: any; notFound?: boolean }> {
    const session = await FocusSession.findOne({
      _id: new Types.ObjectId(sessionId),
      userId: new Types.ObjectId(userId),
    });
    if (!session) return { success: false, notFound: true };
    if (!session.isOpen) return { success: false, throttled: false, session };

    const now = new Date();
    if (enforceThrottle && session.lastHeartbeatAt) {
      const elapsedMs = now.getTime() - new Date(session.lastHeartbeatAt).getTime();
      if (elapsedMs < 45_000) {
        return { success: false, throttled: true, session };
      }
    }

    const activeMs = { $add: [
      { $ifNull: ['$activeDurationMs', 0] },
      { $max: [0, { $subtract: [now, { $ifNull: ['$lastResumedAt', '$startedAt'] }] }] },
    ] };
    const interval = { $ceil: { $divide: [activeMs, FOCUS_HEARTBEAT_SECONDS * 1000] } };
    const coversNewInterval = { $and: [
      { $eq: ['$status', 'running'] },
      { $gt: [interval, { $ifNull: ['$lastCoveredHeartbeatInterval', 0] }] },
    ] };

    const updated = await FocusSession.findOneAndUpdate(
      { _id: new Types.ObjectId(sessionId), userId: new Types.ObjectId(userId), status: { $in: ['running', 'paused'] } },
      [{ $set: {
        heartbeatCount: { $add: [{ $ifNull: ['$heartbeatCount', 0] }, 1] },
        heartbeatsCount: { $add: [{ $ifNull: ['$heartbeatsCount', 0] }, 1] },
        lastHeartbeatAt: { $max: [now, '$lastHeartbeatAt'] },
        coveredHeartbeatIntervals: { $add: [
          { $ifNull: ['$coveredHeartbeatIntervals', 0] },
          { $cond: [coversNewInterval, 1, 0] },
        ] },
        lastCoveredHeartbeatInterval: { $cond: [
          coversNewInterval, interval, '$lastCoveredHeartbeatInterval',
        ] },
      } }],
      { new: true }
    );

    return { success: true, throttled: false, session: updated };
  }

  /**
   * Abandons an active/paused focus session.
   */
  async abandonSession(sessionId: string, userId: string): Promise<any | null> {
    const session = await FocusSession.findOne({
      _id: new Types.ObjectId(sessionId),
      userId: new Types.ObjectId(userId),
    });
    if (!session || !['running', 'paused', 'active'].includes(session.status)) return null;

    const now = new Date();
    const pauses = Array.isArray(session.pauses) ? [...session.pauses] : [];
    for (const p of pauses) {
      if (!p.endedAt) p.endedAt = now;
    }

    const { activeSec, activeDurationMs } = computeActiveDuration({
      startedAt: session.startedAt,
      status: 'abandoned',
      pauses,
      now,
    });

    const abandoned = await FocusSession.findOneAndUpdate(
      { _id: session._id, userId: session.userId, status: session.status },
      {
        $set: {
          status: 'abandoned',
          isOpen: false,
          completedAt: now,
          pauses,
          activeSec,
          activeDurationMs,
          actualDurationMinutes: Math.round(activeSec / 60),
          lastResumedAt: null,
        },
      },
      { new: true }
    );
    return abandoned;
  }

  /**
   * Returns current active/open focus session for user.
   */
  async getActiveSession(userId: string): Promise<any | null> {
    const session = await FocusSession.findOne({
      userId: new Types.ObjectId(userId),
      isOpen: true,
    });
    if (!session) return null;

    const { activeSec, activeDurationMs } = computeActiveDuration({
      startedAt: session.startedAt,
      status: session.status,
      pauses: session.pauses,
    });

    const obj = session.toObject ? session.toObject() : session;
    return { ...obj, activeSec, activeDurationMs };
  }

  /**
   * Atomically records completion, reserves XP and writes the domain event.
   */
  async completeSession(sessionId: string, userId: string): Promise<FocusSessionResult | null> {
    const ownerId = new Types.ObjectId(userId);
    const filter = { _id: sessionId, userId: ownerId };
    const initial = await FocusSession.findOne(filter);
    if (initial?.status === 'completed') return completionResult(initial, true);
    if (!initial || !['running', 'paused', 'active'].includes(initial.status)) return null;

    await ensureUserXp(ownerId);
    const traceContext = getTraceMetadata();
    const { result, runtime } = await runInTransaction(async dbSession => {
      const session = await FocusSession.findOne(filter).session(dbSession);
      if (session?.status === 'completed') return { result: completionResult(session, true), runtime: null };
      if (!session || !['running', 'paused', 'active'].includes(session.status)) return { result: null, runtime: null };
      return this.persistCompletion(session, dbSession, traceContext);
    });
    if (runtime) {
      try {
        await eventBus.emitRuntimeStatePatch(userId, { sessionContext: runtime.sessionContext });
      } catch (error) {
        logger.warn('[focus] Runtime patch delivery failed after completion', { userId, error });
      }
    }
    return result;
  }

  private async persistCompletion(
    session: HydratedDocument<IFocusSession>, dbSession: ClientSession, traceContext: Record<string, string>,
  ) {
    const completedAt = new Date();
    const pauses = Array.isArray(session.pauses) ? [...session.pauses] : [];
    for (const p of pauses) {
      if (!p.endedAt) p.endedAt = completedAt;
    }

    const activeDurationMs = (session.activeDurationMs ?? 0) + (session.status === 'running'
      ? Math.max(0, completedAt.getTime() - (session.lastResumedAt ?? session.startedAt).getTime()) : 0);
    const activeSec = Math.round(activeDurationMs / 1000);
    const actualDurationMinutes = Math.round(activeDurationMs / 60000);
    
    // Quality Score Heuristics
    // 1. Completion Rate (0-50 pts)
    const completionRate = Math.min(1, actualDurationMinutes / (session.plannedDurationMinutes || 25));
    let score = completionRate * 50;

    // 2. Heartbeat Consistency (0-30 pts)
    // Expected 1 heartbeat every 30s. Buffer allowed.
    const expectedHeartbeats = actualDurationMinutes * 2;
    if (expectedHeartbeats > 0) {
      const heartbeatConsistency = Math.min(1, (session.heartbeatCount || session.heartbeatsCount || 0) / expectedHeartbeats);
      score += heartbeatConsistency * 30;
    } else {
      score += 30; // Short session fallback
    }

    // 3. Deep Work Bonus (0-20 pts)
    if (actualDurationMinutes >= 45) score += 20;
    else if (actualDurationMinutes >= 25) score += 10;

    const qualityScore = Math.min(100, Math.max(0, Math.round(score)));

    // Serialize decisions with legacy XP workers that may still settle this day's prior sessions.
    await UserXp.updateOne({ userId: session.userId }, { $inc: { focusReservationVersion: 1 } }, { session: dbSession });
    const prior = await readFocusXpForDay(session.userId, completedAt, dbSession);
    const decision = decideFocusXp({
      plannedSec: session.$isDefault('plannedSec') ? session.plannedDurationMinutes * 60 : session.plannedSec,
      activeSec: computeActiveSec(activeDurationMs),
      coveredHeartbeatIntervals: session.coveredHeartbeatIntervals ?? 0,
    }, prior);
    const completed = await FocusSession.findOneAndUpdate(
      { _id: session._id, userId: session.userId, status: session.status },
      {
        $set: {
          status: 'completed',
          isOpen: false,
          completedAt,
          pauses,
          activeSec,
          actualDurationMinutes,
          activeDurationMs,
          lastResumedAt: null,
          focusQualityScore: qualityScore,
          xp: { amount: decision.xpAmount, reason: decision.reason, capApplied: decision.capApplied },
        },
      },
      { new: true, session: dbSession }
    );
    if (!completed) throw new Error('Focus session disappeared during completion');

    const user = await User.findById(session.userId).select('timezone').session(dbSession).lean();
    const payload = focusSessionCompletedV1Schema.parse({
      sessionId: String(completed._id),
      plannedDurationMinutes: session.plannedDurationMinutes,
      coveredHeartbeatIntervals: completed.coveredHeartbeatIntervals ?? 0,
      activeDurationMs,
      completedAt: completedAt.toISOString(),
      mode: completed.mode,
      timezone: user?.timezone || 'UTC',
      qualified: decision.qualified,
    });
    await writeOutboxEvent(dbSession, {
      type: 'focus.session.completed', schemaVersion: 1, aggregateType: 'focus_session',
      aggregateId: payload.sessionId, userId: String(session.userId), payload, traceContext,
    });
    const runtime = await UnifiedRuntimeState.findOneAndUpdate(
      { userId: session.userId, 'sessionContext.sessionId': payload.sessionId },
      { $set: {
        'sessionContext.isActive': false, 'sessionContext.status': 'completed',
        'sessionContext.activeDurationMs': activeDurationMs, 'sessionContext.lastResumedAt': null,
        'sessionContext.lastHeartbeat': completedAt,
      } },
      { new: true, session: dbSession },
    );
    return { result: completionResult(completed, false), runtime };
  }

  /**
   * Aborts a focus session (e.g. user manually cancelled early).
   */
  async abortSession(sessionId: string, userId: string): Promise<boolean> {
    const userObjId = new Types.ObjectId(userId);
    const sessionObjId = new Types.ObjectId(sessionId);
    const done = await FocusSession.findOneAndUpdate(
      { _id: sessionObjId, userId: userObjId, status: { $in: ['running', 'paused'] } },
      { $set: { status: 'abandoned', completedAt: new Date(), lastResumedAt: null } },
      { new: true }
    );
    if (done) {
      await UnifiedRuntimeState.updateMany(
        { 'sessionContext.sessionId': String(done._id), 'sessionContext.isActive': true },
        { $set: { 'sessionContext.isActive': false, 'sessionContext.status': 'abandoned', 'sessionContext.lastResumedAt': null } }
      );
      try {
        const { cacheManager } = await import('../../shared/cache/cacheManager.js');
        await cacheManager.invalidateDashboard(userId);
      } catch (err) {
        logger.warn('[focus] Failed to invalidate dashboard cache on abort', { userId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return Boolean(done);
  }

  /**
   * Gets recent focus sessions for the user.
   */
  async getSessionHistory(userId: string, limit = 10) {
    return FocusSession.find({ userId: new Types.ObjectId(userId), status: 'completed' })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Gets paginated focus session history with optional status and mode filters.
   */
  async getUserFocusHistory(
    userId: string,
    options: FocusHistoryOptions = {}
  ): Promise<FocusHistoryResult> {
    const userObjId = new Types.ObjectId(userId);
    const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.min(100, Math.max(1, Math.trunc(options.limit)))
      : 20;
    const offset = typeof options.offset === 'number' && Number.isFinite(options.offset)
      ? Math.max(0, Math.trunc(options.offset))
      : 0;

    const query: Record<string, unknown> = {
      userId: userObjId,
    };

    if (options.status && options.status !== 'all') {
      query.status = options.status;
    }

    if (options.mode) {
      query.mode = options.mode;
    }

    const [total, sessions] = await Promise.all([
      FocusSession.countDocuments(query),
      FocusSession.find(query)
        .sort({ startedAt: -1, _id: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
    ]);

    return {
      sessions: sessions.map((s) => ({
        id: s._id.toString(),
        mode: s.mode,
        status: s.status,
        plannedDurationMinutes: s.plannedDurationMinutes,
        actualDurationMinutes: s.actualDurationMinutes ?? 0,
        activeDurationMs: s.activeDurationMs ?? 0,
        focusQualityScore: s.focusQualityScore ?? null,
        startedAt: s.startedAt,
        completedAt: s.completedAt ?? null,
        heartbeatCount: s.heartbeatCount ?? 0,
      })),
      total,
      limit,
      offset,
    };
  }

  /**
   * Calculates aggregated focus session statistics for the user over the given lookback days.
   */
  async getUserFocusSummary(userId: string, days = 30): Promise<FocusSummaryResult> {
    const userObjId = new Types.ObjectId(userId);
    const safeDays = typeof days === 'number' && Number.isFinite(days) && days >= 0
      ? Math.trunc(days)
      : 30;
    const query: Record<string, unknown> = {
      userId: userObjId,
    };

    if (safeDays > 0) {
      const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
      query.startedAt = { $gte: since };
    }

    const sessions = await FocusSession.find(query).lean();

    let completedSessions = 0;
    let abandonedSessions = 0;
    let totalDurationMinutes = 0;
    let qualityScoreSum = 0;
    let qualityScoreCount = 0;
    const modeBreakdown: Record<string, { sessions: number; totalMinutes: number }> = {};

    for (const session of sessions) {
      const modeKey = session.mode || 'default';
      if (!modeBreakdown[modeKey]) {
        modeBreakdown[modeKey] = { sessions: 0, totalMinutes: 0 };
      }
      modeBreakdown[modeKey].sessions += 1;

      if (session.status === 'completed') {
        completedSessions += 1;
        const duration = session.actualDurationMinutes ?? Math.round((session.activeDurationMs ?? 0) / 60000);
        totalDurationMinutes += duration;
        modeBreakdown[modeKey].totalMinutes += duration;

        if (typeof session.focusQualityScore === 'number') {
          qualityScoreSum += session.focusQualityScore;
          qualityScoreCount += 1;
        }
      } else if (session.status === 'abandoned') {
        abandonedSessions += 1;
      }
    }

    const averageQualityScore = qualityScoreCount > 0 ? Math.round(qualityScoreSum / qualityScoreCount) : 0;

    return {
      totalSessions: sessions.length,
      completedSessions,
      abandonedSessions,
      totalDurationMinutes,
      averageQualityScore,
      modeBreakdown,
    };
  }
}

export const focusEngine = new FocusEngine();
