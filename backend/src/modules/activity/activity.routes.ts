// src/modules/activity/activity.routes.ts
import { Router } from 'express';
import { asyncHandler, authMiddleware, validateBody } from '../../middleware/index.js';
import { validateParams, objectIdSchema } from '../../middleware/validation.js';
import * as controller from './activity.controller.js';
import { z } from 'zod';

const router = Router();

const activityCreateSchema = z.object({
  type: z.enum(['problem_solved', 'commit_pushed', 'pr_merged', 'project_created', 'project_updated', 'project_deleted', 'contest_participated', 'streak_milestone', 'note_added', 'settings_updated', 'focus_session']),
  title: z.string().min(1),
  description: z.string(),
  platform: z.string(),
  url: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const focusSessionSchema = z.object({
  duration: z.number().min(1),
  mode: z.string(),
});

const activityIdParamsSchema = z.object({ id: objectIdSchema });

// Unified: GET /api/activity → events + heatmap in single response
router.get('/', authMiddleware, asyncHandler(controller.getAll));

// Focus Sessions
router.get('/focus/history', authMiddleware, asyncHandler(controller.getFocusHistory));
router.get('/focus/summary', authMiddleware, asyncHandler(controller.getFocusSummary));
router.post('/focus/start', authMiddleware, validateBody(focusSessionSchema), asyncHandler(controller.startFocusSession));
router.post('/focus/heartbeat', authMiddleware, asyncHandler(controller.heartbeatFocusSession));
router.post('/focus/pause', authMiddleware, asyncHandler(controller.pauseFocusSession));
router.post('/focus/resume', authMiddleware, asyncHandler(controller.resumeFocusSession));
router.post('/focus/cancel', authMiddleware, asyncHandler(controller.cancelFocusSession));
router.post('/focus/stop', authMiddleware, asyncHandler(controller.stopFocusSession));

// Granular (kept for backward compat)
router.get('/heatmap', authMiddleware, asyncHandler(controller.getHeatmap));
router.get('/feed', authMiddleware, asyncHandler(controller.getFeed));
router.get('/date/:date', authMiddleware, asyncHandler(controller.getActivitiesByDate));
router.post('/', authMiddleware, validateBody(activityCreateSchema), asyncHandler(controller.createActivity));
router.delete('/:id', authMiddleware, validateParams(activityIdParamsSchema), asyncHandler(controller.deleteActivity));

export default router;
