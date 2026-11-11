// src/modules/recommendations/recommendation.routes.ts
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { RecommendationIntelligenceService } from './recommendation.service.js';

const router = Router();
router.use(authMiddleware);

const resumeReference = z.string().min(1).max(200);

// Phase 12: Realism Report Endpoint
router.get('/report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await RecommendationIntelligenceService.getRealismReport();
    res.status(200).json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
});

// Generate and Fetch Intelligence Recommendations
router.get('/intelligence/:resumeReference', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const reference = resumeReference.parse(req.params.resumeReference);
    const recommendations = await RecommendationIntelligenceService.refreshOwnedRecommendations(req.user!.id, reference);

    res.status(200).json({
      success: true,
      data: recommendations
    });
  } catch (error) {
    next(error);
  }
});

export default router;
