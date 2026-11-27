// src/modules/readiness/roadmap.routes.ts — target role roadmap: read, generate, track tasks.
// Mounted under /readiness/roadmap, after the readiness router's auth middleware.
import { Router, type Response } from 'express';
import { z } from 'zod';
import { rateLimiters } from '../../middleware/rateLimitAdvanced.js';
import { withAuth } from '../../shared/controllerUtils.js';
import { ApiResponse, errorResponse, successResponse } from '../../shared/response.js';
import { generateRoadmap, generateRoadmapSchema, getRoadmap, RoadmapError, setTaskCompletion } from './roadmapGenerator.service.js';
import { getResourceForSkill } from './resources/learningResources.js';

const taskParamsSchema = z.object({
  milestoneId: z.string().min(1).max(40),
  taskId: z.string().min(1).max(40),
});
const taskBodySchema = z.object({ completed: z.boolean() });

/** Sends a RoadmapError as its own status; anything else goes to withAuth's 500. */
async function respond(res: Response, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof RoadmapError)) throw err;
    errorResponse(res, err.message, err.code, err.status);
  }
}

const router = Router();

router.get('/', withAuth('[roadmap]', 'get roadmap', (userId, _req, res) =>
  respond(res, async () => ApiResponse.success(res, await getRoadmap(userId)))));

router.get('/resource', withAuth('[roadmap]', 'get skill resource', async (_userId, req, res) => {
  const skill = typeof req.query.skill === 'string' ? req.query.skill.trim() : '';
  if (!skill) {
    ApiResponse.badRequest(res, 'Query parameter "skill" is required');
    return;
  }
  ApiResponse.success(res, getResourceForSkill(skill));
}));

router.post('/generate', rateLimiters.ai, withAuth('[roadmap]', 'generate roadmap', async (userId, req, res) => {
  const parsed = generateRoadmapSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    ApiResponse.badRequest(res, parsed.error.issues.map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '));
    return;
  }
  await respond(res, async () => successResponse(res, await generateRoadmap(userId, parsed.data), 'Roadmap generated', 201));
}));

router.patch('/milestones/:milestoneId/tasks/:taskId', withAuth('[roadmap]', 'update roadmap task', async (userId, req, res) => {
  const params = taskParamsSchema.safeParse(req.params);
  const body = taskBodySchema.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    ApiResponse.badRequest(res, 'Provide a milestone id, a task id and a boolean completed flag');
    return;
  }
  const { milestoneId, taskId } = params.data;
  await respond(res, async () => ApiResponse.success(res, await setTaskCompletion(userId, milestoneId, taskId, body.data.completed)));
}));

export default router;
