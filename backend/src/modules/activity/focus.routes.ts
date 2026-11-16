// ============================================================================
// focus.routes.ts — Server-Authoritative Focus Session Routes
// ============================================================================

import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/error.js';
import { focusController } from './focus.controller.js';

const router = Router();

// All focus session endpoints require authentication
router.use(authMiddleware);

router.post('/', asyncHandler(focusController.startSession.bind(focusController)));
router.get('/active', asyncHandler(focusController.getActiveSession.bind(focusController)));
router.post('/:id/heartbeat', asyncHandler(focusController.recordHeartbeat.bind(focusController)));
router.post('/:id/pause', asyncHandler(focusController.pauseSession.bind(focusController)));
router.post('/:id/resume', asyncHandler(focusController.resumeSession.bind(focusController)));
router.post('/:id/abandon', asyncHandler(focusController.abandonSession.bind(focusController)));
router.post('/:id/complete', asyncHandler(focusController.completeSession.bind(focusController)));

export const focusRoutes = router;
export default router;
