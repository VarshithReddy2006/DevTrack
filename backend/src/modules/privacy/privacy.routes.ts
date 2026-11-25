// src/modules/privacy/privacy.routes.ts — GDPR Data Portability & Right to be Forgotten HTTP Endpoints
import { Router, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { commonErrors } from '../../shared/response.js';
import { logger } from '../../shared/logger.js';
import {
  generateAndNotifyDataExport,
  getExportArchiveByToken,
} from './dataExport.service.js';
import { executeAccountErasure } from './accountErasure.worker.js';
import { getSystemMaintenanceQueue } from '../../shared/jobs/queueFactory.js';

export const privacyRoutes = Router();

const DeleteAccountSchema = z.object({
  confirmation: z.string().refine(
    (val) => val === 'DELETE' || val === 'DELETE_MY_ACCOUNT',
    { message: 'Confirmation must be DELETE or DELETE_MY_ACCOUNT' }
  ),
  password: z.string().optional(),
});

/**
 * POST /api/v2/privacy/export
 * Enqueues a data export job to worker-maintenance and generates a portable ZIP archive.
 * Notifies the client via SSE (privacy.export_ready) with an expiring 24h download link.
 */
privacyRoutes.post('/export', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return commonErrors.unauthorized(res);
  }

  try {
    // Attempt queue dispatch to worker-maintenance if queues are operational
    try {
      const queue = getSystemMaintenanceQueue();
      if (queue) {
        await queue.add(
          'data_export',
          { task: 'data_export', userId },
          { removeOnComplete: true, attempts: 2 }
        );
      }
    } catch (queueErr) {
      logger.warn('[privacy-routes] Queue enqueue failed, falling back to direct export generation', {
        userId,
        error: queueErr,
      });
    }

    // Generate export and register download token
    const result = await generateAndNotifyDataExport(userId);

    return res.status(202).json({
      success: true,
      message: 'Data export initiated. Download link active for 24 hours.',
      downloadUrl: result.downloadUrl,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    logger.error('[privacy-routes] Failed to initiate data export', { userId, error });
    return commonErrors.internalError(res, error instanceof Error ? error.message : 'Export failed');
  }
});

/**
 * GET /api/v2/privacy/export/download/:token
 * Downloads the compiled GDPR ZIP data export archive.
 */
privacyRoutes.get('/export/download/:token', async (req, res) => {
  const { token } = req.params;
  if (!token) {
    return commonErrors.badRequest(res, 'Missing export download token');
  }

  try {
    const archiveBuffer = await getExportArchiveByToken(token);
    if (!archiveBuffer) {
      return res.status(404).json({
        success: false,
        error: 'Export archive not found or expired',
      });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="devtrack-data-export-${token.slice(0, 8)}.zip"`
    );
    res.setHeader('Content-Length', archiveBuffer.length);
    return res.status(200).send(archiveBuffer);
  } catch (error) {
    logger.error('[privacy-routes] Error serving export download', { token, error });
    return commonErrors.internalError(res, 'Failed to download export');
  }
});

/**
 * POST /api/v2/privacy/delete-account
 * Permanently erases the user account, cascading deletions across all collections,
 * clearing Redis cache and leaderboards, anonymizing audit records, and deleting Clerk identity.
 */
privacyRoutes.post('/delete-account', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return commonErrors.unauthorized(res);
  }

  const parseResult = DeleteAccountSchema.safeParse(req.body);
  if (!parseResult.success) {
    return commonErrors.badRequest(
      res,
      parseResult.error.issues.map((i) => i.message).join(', ')
    );
  }

  try {
    const erasureResult = await executeAccountErasure(userId);

    return res.status(200).json({
      success: true,
      message: 'Account and associated personal data successfully erased.',
      details: {
        completedAt: erasureResult.completedAt,
        deletedCollections: Object.keys(erasureResult.deletedCounts).length,
        auditLogTombstoneAppended: erasureResult.tombstoneAppended,
        shreddedAuditKeys: erasureResult.shreddedAuditKeys,
      },
    });
  } catch (error) {
    logger.error('[privacy-routes] Account deletion failed', { userId, error });
    return commonErrors.internalError(res, error instanceof Error ? error.message : 'Erasure failed');
  }
});
