// src/modules/streak/streak.routes.ts — Streak API routes
import { Router } from 'express';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { streakController } from './streak.controller.js';

const router = Router();

// All streak routes require authentication
router.use(authMiddleware);

// GET /streak - Get unified streak status
router.get('/', streakController.getStreak);

// GET /streak/history - Get streak history
router.get('/history', streakController.getHistory);

// GET /streak/:type - Get specific streak type (dsa, github, unified)
router.get('/:type', streakController.getStreakByType);

// POST /streak/record - Record activity (internal/triggered by other systems)
router.post('/record', streakController.recordActivity);

// POST /streak/freeze - Activate streak freeze
router.post('/freeze', streakController.activateFreeze);

export const streakRoutes = router;