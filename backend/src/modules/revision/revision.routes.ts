// src/modules/revision/revision.routes.ts — Revision cards routes
import { Router } from 'express';
import { validateContract } from '../../middleware/validation.js';
import { RevisionQueueQuerySchema, RevisionQueueService } from './revisionQueue.service.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { asyncHandler, authMiddleware } from '../../middleware/index.js';
import {
  getDueCardsController,
  submitReviewController,
  getRevisionAnalyticsController,
} from './revision.controller.js';

const router = Router();

router.get('/queue', authMiddleware, validateContract({ query: RevisionQueueQuerySchema }, async (req, res) => {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
  const data = await RevisionQueueService.getQueue({ userId, ...req.validQuery });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ success: true, count: data.length, data });
}));

router.get('/analytics', authMiddleware, asyncHandler(getRevisionAnalyticsController));

// GET /api/v1/revision/due — fetch user's due revision cards
router.get('/due', authMiddleware, asyncHandler(getDueCardsController));

// POST /api/v1/revision/cards/:id/reviews — submit SM-2 review rating with optimistic concurrency
router.post('/cards/:id/reviews', authMiddleware, asyncHandler(submitReviewController));

export const revisionRoutes = router;
export default router;
