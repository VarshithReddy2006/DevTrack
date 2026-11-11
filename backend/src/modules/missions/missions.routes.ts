// src/modules/missions/missions.routes.ts
import { Router, type Response, type NextFunction } from 'express';
import { getUserMissions, getUserMissionHistory, type MissionHistoryOptions } from './missionProgress.service.js';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';

const router = Router();

// GET /api/missions — Get user's active missions with optional category filter
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const missions = await getUserMissions(userId, category);

    res.json({
      success: true,
      data: missions,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/missions/history — Get completed or expired mission history with pagination & category filter
router.get('/history', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const category = typeof req.query.category === 'string' ? (req.query.category as MissionHistoryOptions['category']) : undefined;
    const status = typeof req.query.status === 'string' ? (req.query.status as MissionHistoryOptions['status']) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;

    const result = await getUserMissionHistory(userId, {
      category,
      status,
      limit,
      offset,
    });

    res.json({
      success: true,
      data: result.missions,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
