import { Router } from 'express';
import { z } from 'zod';
import { trackEvent, submitFeedback, getDashboardMetrics, dashboardQuerySchema } from './analytics.controller';
import { validateBody, validateQuery } from '../../middleware/validation';
import { rateLimiters } from '../../middleware/rateLimitAdvanced';
import { authMiddleware, optionalAuthMiddleware, adminMiddleware } from '../../middleware/auth';

const router = Router();

// Cap on the serialized size of an event's properties
const MAX_PROPERTIES_BYTES = 4096;

// Zod schemas for validation
const eventSchema = z.object({
  // snake_case / dotted names only, e.g. roadmap_generated
  eventName: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/, 'Invalid event name'),
  properties: z
    .record(z.any())
    .optional()
    .default({})
    .refine(
      (props) => Buffer.byteLength(JSON.stringify(props), 'utf8') <= MAX_PROPERTIES_BYTES,
      { message: `properties must be at most ${MAX_PROPERTIES_BYTES} bytes` }
    ),
});

const feedbackSchema = z.object({
  rating: z.string().min(1).max(10),
  feedback: z.string().max(1000).optional(),
  page: z.string().min(1).max(100),
});

// Mount rate limiter on all analytics routes
router.use(rateLimiters.analytics);

// Still callable without a token to catch early drop-offs. A valid token sets req.user,
// which is the only source of userId. Anonymous events are stored without one.
router.post('/event', optionalAuthMiddleware, validateBody(eventSchema), trackEvent);
router.post('/feedback', optionalAuthMiddleware, validateBody(feedbackSchema), submitFeedback);

// Dashboard exposes aggregate funnel metrics and user feedback — admin only
router.get('/dashboard', authMiddleware, adminMiddleware, validateQuery(dashboardQuerySchema), getDashboardMetrics);

export default router;
