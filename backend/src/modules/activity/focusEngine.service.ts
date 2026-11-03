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
}

export const focusEngine = new FocusEngine();
