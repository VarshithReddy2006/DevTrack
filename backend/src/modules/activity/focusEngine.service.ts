// ============================================================================
// focusEngine.service.ts — Focus Engine Backend Service
// ============================================================================
// Manages deep work session persistence, quality scoring, and session history.
// ============================================================================

import { Types } from 'mongoose';
import { FocusSession, UnifiedRuntimeState } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';

export interface FocusSessionResult {
  sessionId: string;
  qualityScore: number;
  actualDuration: number;
  activeDurationMs: number;
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
  code = 'FOCUS_SESSION_ACTIVE';
  constructor() {
    super('A focus session is already active. Stop or cancel it before starting a new one.');
    this.name = 'FocusSessionConflictError';
  }
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
  async startSession(userId: string, mode: string, durationMinutes: number): Promise<{ sessionId: string; startedAt: Date }> {
    const userObjId = new Types.ObjectId(userId);
    await this.reapStaleSessions({ userId });
    const startedAt = new Date();
    try {
      const session = await FocusSession.create({
        userId: userObjId,
        mode,
        status: 'running',
        startedAt,
        lastResumedAt: startedAt,
        lastHeartbeatAt: startedAt,
        activeDurationMs: 0,
        plannedDurationMinutes: durationMinutes,
      });
      return { sessionId: session._id.toString(), startedAt };
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new FocusSessionConflictError();
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
        { $set: { status: 'abandoned', completedAt: now, lastResumedAt: null } },
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
    const session = await FocusSession.findOne({ _id: sessionId, userId: new Types.ObjectId(userId) });
    if (!session || session.status !== 'running') return null;
    const now = new Date();
    const activeDurationMs = (session.activeDurationMs ?? 0) + Math.max(0, now.getTime() - (session.lastResumedAt ?? session.startedAt).getTime());
    const paused = await FocusSession.findOneAndUpdate(
      { _id: session._id, userId: session.userId, status: 'running' },
      { $set: { status: 'paused', activeDurationMs, lastResumedAt: null, lastHeartbeatAt: now } },
      { new: true }
    );
    return paused ? { activeDurationMs, lastResumedAt: null } : null;
  }

  async resumeSession(sessionId: string, userId: string): Promise<FocusTiming | null> {
    const now = new Date();
    const resumed = await FocusSession.findOneAndUpdate(
      { _id: sessionId, userId: new Types.ObjectId(userId), status: 'paused' },
      { $set: { status: 'running', lastResumedAt: now, lastHeartbeatAt: now } },
      { new: true }
    );
    return resumed ? { activeDurationMs: resumed.activeDurationMs ?? 0, lastResumedAt: now } : null;
  }

  /**
   * Records a heartbeat to verify active focus.
   */
  async recordHeartbeat(sessionId: string, userId: string): Promise<void> {
    await FocusSession.updateOne(
      { _id: new Types.ObjectId(sessionId), userId: new Types.ObjectId(userId), status: { $in: ['running', 'paused'] } },
      { $inc: { heartbeatCount: 1 }, $set: { lastHeartbeatAt: new Date() } }
    );
  }

  /**
   * Completes a focus session and calculates the quality score.
   */
  async completeSession(sessionId: string, userId: string): Promise<FocusSessionResult | null> {
    const session = await FocusSession.findOne({ _id: sessionId, userId: new Types.ObjectId(userId) });
    if (!session || !['running', 'paused'].includes(session.status)) return null;

    const completedAt = new Date();
    const activeDurationMs = (session.activeDurationMs ?? 0) + (session.status === 'running'
      ? Math.max(0, completedAt.getTime() - (session.lastResumedAt ?? session.startedAt).getTime()) : 0);
    const actualDurationMinutes = Math.round(activeDurationMs / 60000);
    
    // Quality Score Heuristics
    // 1. Completion Rate (0-50 pts)
    const completionRate = Math.min(1, actualDurationMinutes / session.plannedDurationMinutes);
    let score = completionRate * 50;

    // 2. Heartbeat Consistency (0-30 pts)
    // Expected 1 heartbeat every 30s. Buffer allowed.
    const expectedHeartbeats = actualDurationMinutes * 2;
    if (expectedHeartbeats > 0) {
      const heartbeatConsistency = Math.min(1, session.heartbeatCount / expectedHeartbeats);
      score += heartbeatConsistency * 30;
    } else {
      score += 30; // Short session fallback
    }

    // 3. Deep Work Bonus (0-20 pts)
    if (actualDurationMinutes >= 45) score += 20;
    else if (actualDurationMinutes >= 25) score += 10;

    const qualityScore = Math.min(100, Math.max(0, Math.round(score)));

    // Flip the status atomically. If another request already completed (or
    // cancelled) this session between the read above and now, the filter no
    // longer matches and exactly one caller gets a result.
    const completed = await FocusSession.findOneAndUpdate(
      { _id: session._id, userId: session.userId, status: session.status },
      {
        $set: {
          status: 'completed',
          completedAt,
          actualDurationMinutes,
          activeDurationMs,
          lastResumedAt: null,
          focusQualityScore: qualityScore,
        },
      },
      { new: true }
    );
    if (!completed) return null;

    return {
      sessionId: completed._id.toString(),
      qualityScore,
      actualDuration: actualDurationMinutes,
      activeDurationMs,
    };
  }

  /**
   * Aborts a focus session (e.g. user manually cancelled early).
   */
  async abortSession(sessionId: string, userId: string): Promise<void> {
    await FocusSession.updateOne(
      { _id: new Types.ObjectId(sessionId), userId: new Types.ObjectId(userId), status: { $in: ['running', 'paused'] } },
      { status: 'abandoned', completedAt: new Date() }
    );
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
