// ============================================================================
// focusEngine.service.ts — Focus Engine Backend Service
// ============================================================================
// Manages deep work session persistence, quality scoring, and session history.
// ============================================================================

import { Types } from 'mongoose';
import { FocusSession } from '../../db/models/index.js';
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

export class FocusEngine {
  /**
   * Starts a new focus session and persists it.
   */
  async startSession(userId: string, mode: string, durationMinutes: number): Promise<{ sessionId: string; startedAt: Date }> {
    const startedAt = new Date();
    const session = await FocusSession.create({
      userId: new Types.ObjectId(userId),
      mode,
      status: 'running',
      startedAt,
      lastResumedAt: startedAt,
      activeDurationMs: 0,
      plannedDurationMinutes: durationMinutes,
    });
    return { sessionId: session._id.toString(), startedAt };
  }

  async pauseSession(sessionId: string): Promise<FocusTiming | null> {
    const session = await FocusSession.findById(sessionId);
    if (!session || session.status !== 'running') return null;
    const now = new Date();
    session.activeDurationMs = (session.activeDurationMs ?? 0) + Math.max(0, now.getTime() - (session.lastResumedAt ?? session.startedAt).getTime());
    session.lastResumedAt = null;
    session.status = 'paused';
    await session.save();
    return { activeDurationMs: session.activeDurationMs, lastResumedAt: null };
  }

  async resumeSession(sessionId: string): Promise<FocusTiming | null> {
    const session = await FocusSession.findById(sessionId);
    if (!session || session.status !== 'paused') return null;
    session.lastResumedAt = new Date();
    session.status = 'running';
    await session.save();
    return { activeDurationMs: session.activeDurationMs ?? 0, lastResumedAt: session.lastResumedAt };
  }

  /**
   * Records a heartbeat to verify active focus.
   */
  async recordHeartbeat(sessionId: string): Promise<void> {
    await FocusSession.updateOne(
      { _id: new Types.ObjectId(sessionId) },
      { $inc: { heartbeatCount: 1 } }
    );
  }

  /**
   * Completes a focus session and calculates the quality score.
   */
  async completeSession(sessionId: string): Promise<FocusSessionResult | null> {
    const session = await FocusSession.findById(sessionId);
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
      { _id: session._id, status: session.status },
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
  async abortSession(sessionId: string): Promise<void> {
    await FocusSession.updateOne(
      { _id: new Types.ObjectId(sessionId), status: { $in: ['running', 'paused'] } },
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
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const offset = Math.max(0, options.offset ?? 0);

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
    const query: Record<string, unknown> = {
      userId: userObjId,
    };

    if (days > 0) {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
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
