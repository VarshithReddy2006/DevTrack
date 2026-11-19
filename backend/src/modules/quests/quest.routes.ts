import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { validateContract } from '../../middleware/validation.js';
import { rateLimiters } from '../../middleware/rateLimitAdvanced.js';
import { listUserQuests, questObjectId } from './questEngine.service.js';
import { processQuestReward } from '../xp/processor.js';

export const questRoutes = Router();
questRoutes.use(authMiddleware);
questRoutes.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
questRoutes.get('/', rateLimiters.xp, validateContract({}, async (req, res) => {
  res.json({ success: true, data: await listUserQuests((req as AuthenticatedRequest).user!.id) });
}));
questRoutes.post('/:questId/claim', rateLimiters.xp, validateContract({
  params: z.object({ questId: questObjectId }), body: z.object({}).strict().default({}),
}, async (req, res) => {
  res.json({ success: true, data: await processQuestReward((req as AuthenticatedRequest).user!.id, req.validParams.questId) });
}));
