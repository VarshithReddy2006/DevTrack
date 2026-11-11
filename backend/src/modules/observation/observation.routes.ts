// src/modules/observation/observation.routes.ts — Observation & Telemetry routes
import { Router, Response } from 'express';
import mongoose from 'mongoose';
import { authMiddleware, AuthenticatedRequest } from '../../middleware/auth.js';
import {
  sessionReplay,
  SessionNotFoundError,
  SessionForbiddenError,
} from './sessionReplay.service.js';
import { insightsService } from './insights.service.js';
import { momentumEngine } from './momentumEngine.service.js';
import { retentionEngine } from './retentionEngine.service.js';
import { logger } from '../../shared/logger.js';

const router = Router();

// Start UX tracking session
router.post(
  '/session/start',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { sessionId, deviceInfo } = req.body;
      if (!sessionId || !deviceInfo) {
        res.status(400).json({ error: 'sessionId and deviceInfo are required' });
        return;
      }

      await sessionReplay.startSession({
        sessionId,
        userId: new mongoose.Types.ObjectId(req.user!.id),
        startTime: new Date(),
        deviceInfo: {
          userAgent: deviceInfo.userAgent || '',
          viewport: deviceInfo.viewport || { width: 1280, height: 800 },
          deviceType: deviceInfo.deviceType || 'desktop',
        },
      });

      res.status(200).json({ success: true });
    } catch (err: any) {
      if (err instanceof SessionForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error('[observation] Failed to start session', { error: err.message });
      res.status(500).json({ error: 'Failed to start session' });
    }
  }
);

// End UX tracking session
router.post(
  '/session/end',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }

      await sessionReplay.endSession(sessionId, req.user!.id);
      res.status(200).json({ success: true });
    } catch (err: any) {
      if (err instanceof SessionForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof SessionNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      logger.error('[observation] Failed to end session', { error: err.message });
      res.status(500).json({ error: 'Failed to end session' });
    }
  }
);

// Ingest telemetry events (page view, interaction, friction)
router.post(
  '/events',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { sessionId, events } = req.body;
      if (!sessionId || !Array.isArray(events)) {
        res.status(400).json({ error: 'sessionId and events array are required' });
        return;
      }

      await sessionReplay.recordEventsBatch(sessionId, req.user!.id, events);
      res.status(200).json({ success: true });
    } catch (err: any) {
      if (err instanceof SessionForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof SessionNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      logger.error('[observation] Failed to ingest telemetry events', { error: err.message });
      res.status(500).json({ error: 'Failed to ingest telemetry' });
    }
  }
);

// Get single session replay by ID
router.get(
  '/session/:sessionId',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const paramId = req.params.sessionId;
      const sessionId = Array.isArray(paramId) ? paramId[0] : paramId;
      if (!sessionId) {
        res.status(400).json({ error: 'sessionId is required' });
        return;
      }

      const replay = await sessionReplay.getSessionReplay(sessionId, req.user!.id);
      if (!replay) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.status(200).json({ success: true, data: replay });
    } catch (err: any) {
      if (err instanceof SessionForbiddenError) {
        res.status(403).json({ error: err.message });
        return;
      }
      if (err instanceof SessionNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      logger.error('[observation] Failed to get session replay', { error: err.message });
      res.status(500).json({ error: 'Failed to get session replay' });
    }
  }
);

// Get AI momentum & weakness insights
router.get(
  '/insights',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const insights = await insightsService.getInsights(req.user!.id);
      res.status(200).json({ success: true, data: insights });
    } catch (err: any) {
      logger.error('[observation] Failed to get insights', { error: err.message });
      res.status(500).json({ error: 'Failed to get insights' });
    }
  }
);

// Get full momentum intelligence payload
router.get(
  '/momentum',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const intelligence = await momentumEngine.getFullIntelligence(req.user!.id);
      res.status(200).json({ success: true, data: intelligence });
    } catch (err: any) {
      logger.error('[observation] Failed to get momentum intelligence', { error: err.message });
      res.status(500).json({ error: 'Failed to get momentum intelligence' });
    }
  }
);

// Get retention context (streak pressure, recovery, milestones, messaging)
router.get(
  '/retention',
  authMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      let momentumScore;
      try {
        const momentum = await momentumEngine.calculateMomentumScore(req.user!.id);
        momentumScore = momentum;
      } catch (err) {
        logger.warn('[observation] Momentum calculation failed, proceeding without it', { userId: req.user!.id, error: err instanceof Error ? err.message : String(err) });
      }

      const context = await retentionEngine.getRetentionContext(req.user!.id, momentumScore);
      res.status(200).json({ success: true, data: context });
    } catch (err: any) {
      logger.error('[observation] Failed to get retention context', { error: err.message });
      res.status(500).json({ error: 'Failed to get retention context' });
    }
  }
);

export const observationRoutes = router;
