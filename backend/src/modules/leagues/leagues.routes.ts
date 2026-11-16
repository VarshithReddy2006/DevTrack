// src/modules/leagues/leagues.routes.ts — Weekly leagues API (mounted at /api/v1/leagues)
import { Router, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, authMiddleware } from '../../middleware/index.js';
import type { AuthenticatedRequest } from '../../middleware/index.js';
import { commonErrors, successResponse } from '../../shared/response.js';
import { getCurrentStandings, setParticipation } from './leagues.service.js';
import { getLeagueScoreStore } from './scoreStore.js';

const router = Router();

const participationSchema = z.object({ participate: z.boolean() }).strict();

// GET /api/v1/leagues/current — the caller's cohort standings for the running week (L-01)
router.get('/current', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return commonErrors.unauthorized(res);

  const view = await getCurrentStandings(userId, getLeagueScoreStore());
  successResponse(res, view, 'League standings retrieved successfully');
}));

// PUT /api/v1/leagues/participation — opt in or out of weekly leagues (default: out)
router.put('/participation', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return commonErrors.unauthorized(res);

  const parsed = participationSchema.safeParse(req.body);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || '_root';
      (details[key] ??= []).push(issue.message);
    }
    return commonErrors.validationError(res, details);
  }

  const result = await setParticipation(userId, parsed.data.participate, new Date(), getLeagueScoreStore());
  successResponse(res, result, parsed.data.participate ? 'Joined weekly leagues' : 'Left weekly leagues');
}));

export const leaguesRoutes = router;
export default router;
