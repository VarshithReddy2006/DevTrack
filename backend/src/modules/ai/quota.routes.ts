// src/modules/ai/quota.routes.ts — AI Quota Status Endpoints
import { Router } from 'express';
import { asyncHandler, authMiddleware } from '../../middleware/index.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { quotaService } from './quota.service.js';

const router = Router();

/**
 * GET /api/v1/ai/quota — Returns current daily AI quota limits and remaining usage
 */
router.get(
  '/quota',
  authMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.user!.id;
    const quotaStatus = await quotaService.getQuotaStatus(userId);

    res.status(200).json({
      success: true,
      data: quotaStatus,
    });
  })
);

export default router;
export { router as aiQuotaRoutes };
