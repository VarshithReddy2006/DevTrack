// src/modules/interview/interview.routes.ts — mock interview API (mounted at /api/v1/interviews)
import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { rateLimiters } from '../../middleware/rateLimitAdvanced.js';
import { createInterviewController } from './interview.controller.js';

const router = Router();
const controller = createInterviewController();

// Static path first so "current" is never read as a session id.
router.get('/current', authMiddleware, controller.current);
router.get('/:sessionId', authMiddleware, controller.get);
// Starting and answering cost model calls, so they share the AI rate limit.
router.post('/', authMiddleware, rateLimiters.ai, controller.start);
router.post('/:sessionId/turns/:turnIndex/answer', authMiddleware, rateLimiters.ai, controller.answer);
router.post('/:sessionId/turns/:turnIndex/hint', authMiddleware, controller.hint);
router.post('/:sessionId/finish', authMiddleware, controller.finish);

export const interviewRoutes = router;
export default router;
