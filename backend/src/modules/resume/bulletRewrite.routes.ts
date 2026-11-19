import { Router } from 'express';
import { BulletRewriteRequestSchema } from '@devtrack/contracts';
import { authMiddleware, type AuthenticatedRequest } from '../../middleware/auth.js';
import { rateLimiters } from '../../middleware/rateLimitAdvanced.js';
import { validateContract } from '../../middleware/validation.js';
import { bulletRewriteService } from './bulletRewrite.service.js';

export const bulletRewriteRoutes = Router();
bulletRewriteRoutes.post('/bullets/suggest', authMiddleware, rateLimiters.expensiveAction,
  validateContract({ body: BulletRewriteRequestSchema }, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const data = await bulletRewriteService.suggest((req as AuthenticatedRequest).user!.id, req.validBody);
    res.json({ success: true, data });
  }));
