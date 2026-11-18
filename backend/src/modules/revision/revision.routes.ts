// src/modules/revision/revision.routes.ts — Revision cards routes
import { Router } from 'express';
import { asyncHandler, authMiddleware } from '../../middleware/index.js';
import {
  getDueCardsController,
  submitReviewController,
  getRevisionAnalyticsController,
} from './revision.controller.js';

const router = Router();

router.get('/analytics', authMiddleware, asyncHandler(getRevisionAnalyticsController));

// GET /api/v1/revision/due — fetch user's due revision cards
router.get('/due', authMiddleware, asyncHandler(getDueCardsController));

// POST /api/v1/revision/cards/:id/reviews — submit SM-2 review rating with optimistic concurrency
router.post('/cards/:id/reviews', authMiddleware, asyncHandler(submitReviewController));

export const revisionRoutes = router;
export default router;
