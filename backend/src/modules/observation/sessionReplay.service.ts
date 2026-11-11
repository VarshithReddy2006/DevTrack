// src/modules/observation/sessionReplay.service.ts — Session Replay Service
// Phase-J: Real User Observation System - Session replay metadata and UX friction tracking

import mongoose from 'mongoose';
import { SessionReplay } from '../../db/models/sessionReplay.model.js';
import { BetaUser } from '../../db/models/betaUser.model.js';
import { logger } from '../../shared/logger.js';

export class SessionNotFoundError extends Error {
  statusCode = 404;
  constructor(message: string = 'Session not found') {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionForbiddenError extends Error {
  statusCode = 403;
  constructor(message: string = 'Forbidden: session does not belong to user') {
    super(message);
    this.name = 'SessionForbiddenError';
  }
}

const MAX_PAGES = 500;
const MAX_INTERACTIONS = 2000;
const MAX_FRICTION_EVENTS = 1000;
const MAX_NETWORK_REQUESTS = 1000;

export interface SessionMetadata {
  sessionId: string;
  userId: mongoose.Types.ObjectId;
  startTime: Date;
  deviceInfo: {
    userAgent: string;
    viewport: { width: number; height: number };
    deviceType?: 'desktop' | 'tablet' | 'mobile';
  };
}

export interface InteractionEvent {
  sessionId: string;
  element: string;
  action: string;
  timestamp: Date;
  context?: Record<string, unknown>;
}

export interface FrictionEvent {
  sessionId: string;
  element: string;
  type: 'hesitation' | 'confusion' | 'error' | 'abandonment';
  severity: 'low' | 'medium' | 'high';
  timestamp: Date;
  context?: Record<string, unknown>;
}

function normalizeUserId(id?: string | mongoose.Types.ObjectId): string | null {
  if (!id) return null;
  return id.toString();
}

export const sessionReplay = {
  // ─── Start Session Replay ────────────────────────────────────────────────
  async startSession(metadata: SessionMetadata): Promise<void> {
    const existing = await SessionReplay.findOne({ sessionId: metadata.sessionId }).lean();
    if (existing) {
      if (existing.userId.toString() !== metadata.userId.toString()) {
        throw new SessionForbiddenError('Session belongs to another user');
      }
      return;
    }

    const betaUser = await BetaUser.findOne({ userId: metadata.userId }).lean();

    await SessionReplay.create({
      sessionId: metadata.sessionId,
      userId: metadata.userId,
      betaUserId: betaUser?._id,
      cohortId: betaUser?.cohortId,
      startTime: metadata.startTime,
      pages: [],
      interactions: [],
      frictionEvents: [],
      networkRequests: [],
      performanceMetrics: {},
      deviceInfo: metadata.deviceInfo,
      diagnosticsEnabled: betaUser?.diagnosticsEnabled ?? true,
    });

    logger.debug('[session-replay] Session started', { sessionId: metadata.sessionId });
  },

  // ─── End Session Replay ─────────────────────────────────────────────────
  async endSession(sessionId: string, userId?: string | mongoose.Types.ObjectId): Promise<void> {
    const replay = await SessionReplay.findOne({ sessionId });
    if (!replay) {
      throw new SessionNotFoundError(`Session ${sessionId} not found`);
    }

    const normalizedReqUser = normalizeUserId(userId);
    if (normalizedReqUser && replay.userId.toString() !== normalizedReqUser) {
      throw new SessionForbiddenError('Forbidden: session does not belong to user');
    }

    const endTime = new Date();
    const duration = Math.max(0, endTime.getTime() - replay.startTime.getTime());

    await SessionReplay.updateOne(
      { sessionId, userId: replay.userId },
      { $set: { endTime, duration } }
    );

    logger.debug('[session-replay] Session ended', { sessionId, duration });
  },

  // ─── Record Page View ───────────────────────────────────────────────────
  async recordPageView(sessionId: string, path: string, userId?: string | mongoose.Types.ObjectId): Promise<void> {
    const replay = await SessionReplay.findOne({ sessionId });
    if (!replay) {
      throw new SessionNotFoundError(`Session ${sessionId} not found`);
    }

    const normalizedReqUser = normalizeUserId(userId);
    if (normalizedReqUser && replay.userId.toString() !== normalizedReqUser) {
      throw new SessionForbiddenError('Forbidden: session does not belong to user');
    }

    const enteredAt = new Date();
    await SessionReplay.updateOne(
      { sessionId, userId: replay.userId },
      {
        $push: {
          pages: {
            $each: [{ path, enteredAt }],
            $slice: -MAX_PAGES,
          },
        },
      }
    );
  },

  // ─── Record Interaction ────────────────────────────────────────────────
  async recordInteraction(event: InteractionEvent, userId?: string | mongoose.Types.ObjectId): Promise<void> {
    const replay = await SessionReplay.findOne({ sessionId: event.sessionId });
    if (!replay) {
      throw new SessionNotFoundError(`Session ${event.sessionId} not found`);
    }

    const normalizedReqUser = normalizeUserId(userId);
    if (normalizedReqUser && replay.userId.toString() !== normalizedReqUser) {
      throw new SessionForbiddenError('Forbidden: session does not belong to user');
    }

    await SessionReplay.updateOne(
      { sessionId: event.sessionId, userId: replay.userId },
      {
        $push: {
          interactions: {
            $each: [
              {
                element: event.element,
                action: event.action,
                timestamp: event.timestamp || new Date(),
                context: event.context,
              },
            ],
            $slice: -MAX_INTERACTIONS,
          },
        },
      }
    );
  },

  // ─── Record Friction Event ──────────────────────────────────────────────
  async recordFrictionEvent(event: FrictionEvent, userId?: string | mongoose.Types.ObjectId): Promise<void> {
    const replay = await SessionReplay.findOne({ sessionId: event.sessionId });
    if (!replay) {
      throw new SessionNotFoundError(`Session ${event.sessionId} not found`);
    }

    const normalizedReqUser = normalizeUserId(userId);
    if (normalizedReqUser && replay.userId.toString() !== normalizedReqUser) {
      throw new SessionForbiddenError('Forbidden: session does not belong to user');
    }

    await SessionReplay.updateOne(
      { sessionId: event.sessionId, userId: replay.userId },
      {
        $push: {
          frictionEvents: {
            $each: [
              {
                element: event.element,
                type: event.type,
                severity: event.severity,
                timestamp: event.timestamp || new Date(),
                context: event.context,
              },
            ],
            $slice: -MAX_FRICTION_EVENTS,
          },
        },
      }
    );

    logger.debug('[session-replay] Friction event recorded', { sessionId: event.sessionId, type: event.type });
  },

  // ─── Record Network Request ─────────────────────────────────────────────
  async recordNetworkRequest(
    sessionId: string,
    url: string,
    method: string,
    status: number,
    duration: number,
    userId?: string | mongoose.Types.ObjectId
  ): Promise<void> {
    const replay = await SessionReplay.findOne({ sessionId });
    if (!replay) {
      throw new SessionNotFoundError(`Session ${sessionId} not found`);
    }

    const normalizedReqUser = normalizeUserId(userId);
    if (normalizedReqUser && replay.userId.toString() !== normalizedReqUser) {
      throw new SessionForbiddenError('Forbidden: session does not belong to user');
    }

    await SessionReplay.updateOne(
      { sessionId, userId: replay.userId },
      {
        $push: {
          networkRequests: {
            $each: [
              {
                url,
                method,
                status,
                duration,
                timestamp: new Date(),
              },
            ],
            $slice: -MAX_NETWORK_REQUESTS,
          },
        },
      }
    );
  },

  // ─── Record Performance Metrics ────────────────────────────────────────
  async recordPerformanceMetrics(
    sessionId: string,
    metrics: {
      loadTime?: number;
      firstContentfulPaint?: number;
      timeToInteractive?: number;
      cumulativeLayoutShift?: number;
    },
    userId?: string | mongoose.Types.ObjectId
  ): Promise<void> {
    const replay = await SessionReplay.findOne({ sessionId });
    if (!replay) {
      throw new SessionNotFoundError(`Session ${sessionId} not found`);
    }

    const normalizedReqUser = normalizeUserId(userId);
    if (normalizedReqUser && replay.userId.toString() !== normalizedReqUser) {
      throw new SessionForbiddenError('Forbidden: session does not belong to user');
    }

    const setObj: Record<string, number> = {};
    if (metrics.loadTime !== undefined) setObj['performanceMetrics.loadTime'] = metrics.loadTime;
    if (metrics.firstContentfulPaint !== undefined) setObj['performanceMetrics.firstContentfulPaint'] = metrics.firstContentfulPaint;
    if (metrics.timeToInteractive !== undefined) setObj['performanceMetrics.timeToInteractive'] = metrics.timeToInteractive;
    if (metrics.cumulativeLayoutShift !== undefined) setObj['performanceMetrics.cumulativeLayoutShift'] = metrics.cumulativeLayoutShift;

    await SessionReplay.updateOne(
      { sessionId, userId: replay.userId },
      { $set: setObj }
    );
  },

  // ─── Atomic Batch Ingestion ─────────────────────────────────────────────
  async recordEventsBatch(
    sessionId: string,
    userId: string | mongoose.Types.ObjectId,
    events: Array<{
      event: string;
      timestamp?: string | Date;
      properties?: Record<string, any>;
    }>
  ): Promise<void> {
    const replay = await SessionReplay.findOne({ sessionId });
    if (!replay) {
      throw new SessionNotFoundError(`Session ${sessionId} not found`);
    }

    const normalizedReqUser = normalizeUserId(userId);
    if (normalizedReqUser && replay.userId.toString() !== normalizedReqUser) {
      throw new SessionForbiddenError('Forbidden: session does not belong to user');
    }

    const pagesToPush: Array<{ path: string; enteredAt: Date }> = [];
    const interactionsToPush: Array<{ element: string; action: string; timestamp: Date; context?: Record<string, unknown> }> = [];
    const frictionEventsToPush: Array<{
      element: string;
      type: 'hesitation' | 'confusion' | 'error' | 'abandonment';
      severity: 'low' | 'medium' | 'high';
      timestamp: Date;
      context?: Record<string, unknown>;
    }> = [];
    const networkRequestsToPush: Array<{
      url: string;
      method: string;
      status: number;
      duration: number;
      timestamp: Date;
    }> = [];

    for (const item of events) {
      const timestamp = item.timestamp ? new Date(item.timestamp) : new Date();

      if (item.event === 'page_view') {
        pagesToPush.push({
          path: item.properties?.page || '/',
          enteredAt: timestamp,
        });
      } else if (['hesitation', 'abandonment', 'confusion', 'error_occurred'].includes(item.event)) {
        let mappedType: 'hesitation' | 'abandonment' | 'confusion' | 'error' = 'confusion';
        if (item.event === 'hesitation') mappedType = 'hesitation';
        if (item.event === 'abandonment') mappedType = 'abandonment';
        if (item.event === 'error_occurred') mappedType = 'error';

        frictionEventsToPush.push({
          element: item.properties?.element || 'app',
          type: mappedType,
          severity: item.properties?.severity || 'low',
          timestamp,
          context: item.properties,
        });
      } else if (item.event === 'network_request') {
        networkRequestsToPush.push({
          url: item.properties?.url || '',
          method: item.properties?.method || 'GET',
          status: item.properties?.status || 200,
          duration: item.properties?.duration || 0,
          timestamp,
        });
      } else {
        interactionsToPush.push({
          element: item.properties?.element || 'app',
          action: item.event,
          timestamp,
          context: item.properties,
        });
      }
    }

    const updateOps: any = {};
    if (pagesToPush.length > 0) {
      updateOps.$push = updateOps.$push || {};
      updateOps.$push.pages = {
        $each: pagesToPush,
        $slice: -MAX_PAGES,
      };
    }
    if (interactionsToPush.length > 0) {
      updateOps.$push = updateOps.$push || {};
      updateOps.$push.interactions = {
        $each: interactionsToPush,
        $slice: -MAX_INTERACTIONS,
      };
    }
    if (frictionEventsToPush.length > 0) {
      updateOps.$push = updateOps.$push || {};
      updateOps.$push.frictionEvents = {
        $each: frictionEventsToPush,
        $slice: -MAX_FRICTION_EVENTS,
      };
    }
    if (networkRequestsToPush.length > 0) {
      updateOps.$push = updateOps.$push || {};
      updateOps.$push.networkRequests = {
        $each: networkRequestsToPush,
        $slice: -MAX_NETWORK_REQUESTS,
      };
    }

    if (Object.keys(updateOps).length > 0) {
      await SessionReplay.updateOne(
        { sessionId, userId: replay.userId },
        updateOps
      );
    }
  },

  // ─── Get Session Replay ───────────────────────────────────────────────
  async getSessionReplay(sessionId: string, userId?: string | mongoose.Types.ObjectId) {
    const replay = await SessionReplay.findOne({ sessionId }).lean();
    if (!replay) return null;

    const normalizedReqUser = normalizeUserId(userId);
    if (normalizedReqUser && replay.userId.toString() !== normalizedReqUser) {
      throw new SessionForbiddenError('Forbidden: session does not belong to user');
    }

    return replay;
  },

  // ─── Get User Session Replays ─────────────────────────────────────────
  async getUserSessionReplays(userId: mongoose.Types.ObjectId, limit: number = 10) {
    return SessionReplay.find({ userId })
      .sort({ startTime: -1 })
      .limit(limit)
      .lean();
  },

  // ─── Get Friction Summary ──────────────────────────────────────────────
  async getFrictionSummary(dateRange: { start: Date; end: Date }): Promise<{
    totalFrictionEvents: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
    topElements: Array<{ element: string; count: number }>;
  }> {
    const replays = await SessionReplay.find({
      startTime: { $gte: dateRange.start, $lte: dateRange.end },
    }).lean();

    const byType: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const elementCounts = new Map<string, number>();

    replays.forEach(replay => {
      replay.frictionEvents.forEach(event => {
        byType[event.type] = (byType[event.type] || 0) + 1;
        bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
        elementCounts.set(event.element, (elementCounts.get(event.element) || 0) + 1);
      });
    });

    const topElements = Array.from(elementCounts.entries())
      .map(([element, count]) => ({ element, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalFrictionEvents: replays.reduce((sum, r) => sum + r.frictionEvents.length, 0),
      byType,
      bySeverity,
      topElements,
    };
  },
};

export default sessionReplay;
