// src/routes/index.ts - Route composition
import { Router } from 'express';
import { rateLimit } from '../middleware/rateLimit.js';
import { env } from '../config/index.js';
import { authRoutes } from '../modules/auth/index.js';
import { dashboardRoutes } from '../modules/dashboard/index.js';
import { dsaRoutes } from '../modules/dsa/index.js';
import { activityRoutes } from '../modules/activity/index.js';
import { focusRoutes } from '../modules/activity/focus.routes.js';
import { projectsRoutes } from '../modules/projects/index.js';
import { profileRoutes } from '../modules/profile/index.js';
import { settingsRoutes } from '../modules/settings/index.js';
import { syncRoutes } from '../modules/platform-sync/index.js';
import { handleSseRequest } from '../shared/sse/index.js';
import { xpRoutes } from '../modules/xp/xp.routes.js';
import { streakRoutes } from '../modules/streak/index.js';
import { opsRoutes } from '../modules/ops/ops.routes.js';
import { runtimeStateRoutes } from '../modules/runtime-state/index.js';
import { observationRoutes } from '../modules/observation/index.js';
import missionsRoutes from '../modules/missions/missions.routes.js';
import notificationRoutes from '../modules/notifications/notification.routes.js';
import onboardingRoutes from '../modules/onboarding/onboarding.routes.js';
import { dailyChallengeRoutes } from '../modules/daily-challenge/index.js';
import { coachingRoutes } from '../modules/coaching/index.js';
import { readinessRoutes } from '../modules/readiness/index.js';
import uploadRoutes from '../modules/resume/upload/upload.routes.js';
import recommendationRoutes from '../modules/recommendations/recommendation.routes.js';
import { resumeIntelligenceRoutes } from '../modules/resume/index.js';
import analyticsRoutes from '../modules/analytics/analytics.routes.js';
import { rateLimiters } from '../middleware/rateLimitAdvanced.js';

const router = Router();

// Global rate limit for all API endpoints (less strict than auth endpoints)
const globalRateLimit = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many requests. Please slow down.',
});

// Polling has a dedicated authenticated budget. Keep an IP flood guard before
// auth without exhausting the general 100-request/15-minute API budget.
router.use((req, res, next) => {
  const pollingRead = (req.method === 'GET' || req.method === 'HEAD') && (
    /^\/resume\/session\/[^/]+(?:\/status)?\/?$/i.test(req.path)
    || /^\/resume-intelligence\/report\/[^/]+\/?$/i.test(req.path)
  );
  return pollingRead
    ? rateLimiters.resumeReadIngress(req, res, next)
    : globalRateLimit(req, res, next);
});

// Auth routes (no auth required for login/register)
router.use('/auth', authRoutes);

// SSE endpoint — auth via ?token= query param (EventSource limitation)
router.get('/events', handleSseRequest);

// Protected routes
router.use('/dashboard', dashboardRoutes);
router.use('/dsa', dsaRoutes);
router.use('/activity', activityRoutes);
router.use('/focus/sessions', focusRoutes);
router.use('/projects', projectsRoutes);
router.use('/profile', profileRoutes);
router.use('/settings', settingsRoutes);
router.use('/platforms', rateLimiters.sync, syncRoutes);
router.use('/xp', rateLimiters.xp, xpRoutes);
router.use('/streak', rateLimiters.streak, streakRoutes);
router.use('/ops', opsRoutes);
router.use('/runtime-state', runtimeStateRoutes);
router.use('/observation', observationRoutes);
router.use('/missions', missionsRoutes);
router.use('/notifications', notificationRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/daily-challenge', dailyChallengeRoutes);
router.use('/coaching', rateLimiters.ai, coachingRoutes);
router.use('/readiness', readinessRoutes);
router.use('/resume', uploadRoutes);
router.use('/resume-intelligence', resumeIntelligenceRoutes);
router.use('/recommendations', rateLimiters.ai, recommendationRoutes);
router.use('/analytics', analyticsRoutes);

export default router;
