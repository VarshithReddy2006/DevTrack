// src/modules/search/search.routes.ts
// Express router for the unified search endpoint (GET /api/v2/search).

import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { validateQuery } from '../../middleware/validation.js';
import { asyncHandler } from '../../middleware/error.js';
import { searchQuerySchema } from './search.schema.js';
import { searchHandler } from './search.controller.js';

const router = Router();

router.get(
  '/',
  authMiddleware,
  validateQuery(searchQuerySchema),
  asyncHandler(searchHandler)
);

export default router;
export { router as searchRoutes };
