// src/modules/missions/missions.routes.ts
import { Router, type Response, type NextFunction } from 'express';
import {
  getUserMissions,
  getUserMissionHistory,
  MISSION_CATEGORIES,
  MISSION_HISTORY_STATUSES,
  type MissionCategory,
  type MissionHistoryStatus,
} from './missionProgress.service.js';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';

const router = Router();

function parseOptionalInt(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// GET /api/missions — Get user's active missions with optional category filter
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.id;
    const rawCategory = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (rawCategory !== undefined && !MISSION_CATEGORIES.includes(rawCategory as MissionCategory)) {
      res.status(400).json({
        success: false,
        message: `Invalid category filter. Expected one of: ${MISSION_CATEGORIES.join(', ')}`,
      });
      return;
    }

    const missions = await getUserMissions(userId, rawCategory);

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
    const rawCategory = typeof req.query.category === 'string' ? req.query.category : undefined;
    if (rawCategory !== undefined && !MISSION_CATEGORIES.includes(rawCategory as MissionCategory)) {
      res.status(400).json({
        success: false,
        message: `Invalid category filter. Expected one of: ${MISSION_CATEGORIES.join(', ')}`,
      });
      return;
    }

    const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (rawStatus !== undefined && !MISSION_HISTORY_STATUSES.includes(rawStatus as MissionHistoryStatus)) {
      res.status(400).json({
        success: false,
        message: `Invalid status filter. Expected one of: ${MISSION_HISTORY_STATUSES.join(', ')}`,
      });
      return;
    }

    const limit = parseOptionalInt(req.query.limit);
    const offset = parseOptionalInt(req.query.offset);

    const result = await getUserMissionHistory(userId, {
      category: rawCategory as MissionCategory | undefined,
      status: rawStatus as MissionHistoryStatus | undefined,
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
