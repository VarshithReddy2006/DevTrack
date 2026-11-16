// src/modules/recommendations/recommendation.routes.ts
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { RecommendationIntelligenceService } from './recommendation.service.js';
import { rateLimiters } from '../../middleware/rateLimitAdvanced.js';

const router = Router();
router.use(authMiddleware);

const resumeReference = z.string().min(1).max(200);

// Phase 12: Realism Report Endpoint
router.get('/report', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const report = await RecommendationIntelligenceService.getRealismReport(req.user?.id);
    res.status(200).json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
});

// Reading recommendations never regenerates or mutates stored findings.
router.get('/intelligence/:resumeReference', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const reference = resumeReference.parse(req.params.resumeReference);
    const recommendations = await RecommendationIntelligenceService.getActiveRecommendationsByReference(req.user!.id, reference);

    res.status(200).json({
      success: true,
      data: recommendations.map(row => ({ ...row, id: String(row._id) }))
    });
  } catch (error) {
    next(error);
  }
});

// Regeneration is an explicit, authenticated, rate-limited command.
router.post('/intelligence/:resumeReference/refresh', rateLimiters.expensiveAction, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const reference = resumeReference.parse(req.params.resumeReference);
    const recommendations = await RecommendationIntelligenceService.refreshOwnedRecommendations(req.user!.id, reference);
    res.status(200).json({
      success: true,
      data: recommendations.map(row => ({ ...row, id: String(row._id) }))
    });
  } catch (error) {
    next(error);
  }
});

const actionParams = z.object({
  recommendationId: z.string().regex(/^[a-f\d]{24}$/i),
  action: z.enum(['view', 'accept', 'complete', 'dismiss']),
});

router.post('/intelligence/:recommendationId/:action', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { recommendationId, action } = actionParams.parse(req.params);
    const recommendation = await RecommendationIntelligenceService.applyAction(req.user!.id, recommendationId, action);
    res.json({ success: true, data: recommendation });
  } catch (error) {
    next(error);
  }
});

export default router;
