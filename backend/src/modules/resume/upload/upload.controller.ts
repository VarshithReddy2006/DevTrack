// src/modules/resume-intelligence/upload/upload.controller.ts
import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../../middleware/auth.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { getResumeUploadQueue } from '../../../shared/jobs/queueFactory.js';
import type { ResumeCheckpointJobData } from '../../../shared/jobs/types.js';
import { getRedisHealth } from '../../../shared/redis/index.js';
import { UploadService } from './upload.service.js';
import { successResponse, errorResponse } from '../../../shared/response.js';
import { logger } from '../../../shared/logger.js';

const uploadService = new UploadService();

/**
 * Upload resume file
 */
export async function uploadResume(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.file) {
      errorResponse(res, 'No file uploaded', 'NO_FILE', 400);
      return;
    }

    const userId = (req as any).user?.id;
    const result = await uploadService.processUpload(req.file, userId);

    successResponse(res, result);
  } catch (error) {
    logger.error('[UploadController] Error uploading resume:', error);
    next(error);
  }
}

/** Queue recovery for a failed session owned by the caller. */
export async function resumeSession(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      errorResponse(res, 'Unauthorized', 'UNAUTHORIZED', 401);
      return;
    }

    const sessionId = req.params.id as string;
    const session = await ResumeSession.findOne({ sessionId, userId });
    if (!session) {
      errorResponse(res, 'Session not found', 'NOT_FOUND', 404);
      return;
    }
    if (session.currentStage !== 'FAILED' || !session.failureState?.failed || !session.checkpointState?.stage) {
      errorResponse(res, 'Session has no failed checkpoint to resume', 'SESSION_NOT_RESUMABLE', 409);
      return;
    }
    if (getRedisHealth().status !== 'connected') {
      errorResponse(res, 'Resume processing queue is unavailable', 'QUEUE_UNAVAILABLE', 503);
      return;
    }

    const data: ResumeCheckpointJobData = {
      sessionId,
      userId,
      recoveryRetryCount: session.failureState.retryCount ?? 0,
    };
    await getResumeUploadQueue().add('resume', data, {
      deduplication: { id: `resume-${sessionId}` },
    });
    successResponse(res, { sessionId }, 'Resume recovery queued', 202);
  } catch (error) {
    next(error);
  }
}

/**
 * Get resume session by ID
 */
export async function getSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.params.id as string;
    const session = await uploadService.getSession(sessionId);

    if (!session) {
      errorResponse(res, 'Session not found', 'NOT_FOUND', 404);
      return;
    }

    successResponse(res, session);
  } catch (error) {
    logger.error('[UploadController] Error getting session:', error);
    next(error);
  }
}

/**
 * Get session status
 */
export async function getSessionStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = req.params.id as string;
    const status = await uploadService.getSessionStatus(sessionId);

    if (!status) {
      errorResponse(res, 'Session not found', 'NOT_FOUND', 404);
      return;
    }

    successResponse(res, status);
  } catch (error) {
    logger.error('[UploadController] Error getting session status:', error);
    next(error);
  }
}
