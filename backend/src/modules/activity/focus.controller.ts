// ============================================================================
// focus.controller.ts — Server-Authoritative Focus Session Controller
// ============================================================================

import type { Response } from 'express';
import { Types } from 'mongoose';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { focusEngine, FocusSessionConflictError } from './focusEngine.service.js';

export class FocusController {
  async startSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.user!.id;
    const { mode, plannedDurationMinutes, plannedSec } = req.body || {};

    try {
      const result = await focusEngine.startSession(userId, {
        mode,
        plannedDurationMinutes,
        plannedSec,
      });

      res.status(201).json({
        success: true,
        message: 'Focus session started',
        data: result.session || {
          sessionId: result.sessionId,
          startedAt: result.startedAt,
        },
      });
    } catch (err: any) {
      if (err instanceof FocusSessionConflictError || err.code === 'FOCUS_SESSION_ALREADY_OPEN') {
        res.status(409).json({
          success: false,
          code: 'FOCUS_SESSION_ALREADY_OPEN',
          message: err.message || 'A focus session is already open',
          data: err.data,
        });
        return;
      }
      throw err;
    }
  }

  async getActiveSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.user!.id;
    const session = await focusEngine.getActiveSession(userId);

    if (!session) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'No active focus session found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: session,
    });
  }

  async recordHeartbeat(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.user!.id;
    const id = String(req.params.id || '');

    if (!Types.ObjectId.isValid(id)) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    const result = await focusEngine.recordHeartbeat(id, userId, true);

    if (result.notFound) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    if (result.throttled) {
      res.status(429).json({
        success: false,
        code: 'HEARTBEAT_TOO_FREQUENT',
        message: 'Heartbeat interval too short (minimum 45s)',
        data: result.session,
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Heartbeat recorded',
      data: result.session,
    });
  }

  async pauseSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.user!.id;
    const id = String(req.params.id || '');

    if (!Types.ObjectId.isValid(id)) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    const result = await focusEngine.pauseSession(id, userId);

    if (!result) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    const session = (await focusEngine.getActiveSession(userId)) || result;
    res.status(200).json({
      success: true,
      message: 'Focus session paused',
      data: session,
    });
  }

  async resumeSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.user!.id;
    const id = String(req.params.id || '');

    if (!Types.ObjectId.isValid(id)) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    const result = await focusEngine.resumeSession(id, userId);

    if (!result) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    const session = (await focusEngine.getActiveSession(userId)) || result;
    res.status(200).json({
      success: true,
      message: 'Focus session resumed',
      data: session,
    });
  }

  async abandonSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.user!.id;
    const id = String(req.params.id || '');

    if (!Types.ObjectId.isValid(id)) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    const result = await focusEngine.abandonSession(id, userId);

    if (!result) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Focus session abandoned',
      data: result,
    });
  }

  async completeSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    const userId = req.user!.id;
    const id = String(req.params.id || '');

    if (!Types.ObjectId.isValid(id)) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    const result = await focusEngine.completeSession(id, userId);

    if (!result) {
      res.status(404).json({
        success: false,
        code: 'FOCUS_SESSION_NOT_FOUND',
        message: 'Focus session not found',
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: 'Focus session completed',
      data: (result as any).session || result,
    });
  }
}

export const focusController = new FocusController();
