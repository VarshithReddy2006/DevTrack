// src/modules/dsa/dsa.routes.ts
import { Router } from 'express';
import { asyncHandler, authMiddleware, validateBody } from '../../middleware/index.js';
import { validateQuery, validateParams, objectIdSchema } from '../../middleware/validation.js';
import * as controller from './dsa.controller.js';
import { z } from 'zod';
import { isReservedPlatformTopic } from './dsa.constants.js';

const router = Router();

const problemCreateSchema = z.object({
  title: z.string().min(1),
  platform: z.enum(['leetcode', 'codeforces']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  url: z.string().url(),
  tags: z.array(z.string()),
  category: z.string().min(1).refine((value) => !isReservedPlatformTopic(value), {
    message: 'Category name is reserved for platform sync summaries',
  }),
  notes: z.string().optional(),
});

const problemUpdateSchema = z.object({
  status: z.enum(['unsolved', 'attempted', 'solved', 'revisit']).optional(),
  notes: z.string().optional(),
  timeTaken: z.number().optional(),
  isFavorite: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

const bulkUpdateSchema = z.object({
  problemIds: z.array(
    z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid problem ID format'),
  ).min(1, 'At least one problem ID is required'),
  status: z.enum(['unsolved', 'attempted', 'solved', 'revisit']),
});

// Only the search term is checked here, the other filters are read as before.
const problemListQuerySchema = z.object({
  search: z.string().max(100).optional(),
}).passthrough();

const problemIdParamsSchema = z.object({ id: objectIdSchema });

router.get('/problems', authMiddleware, validateQuery(problemListQuerySchema), asyncHandler(controller.getProblems));
router.get('/problems/:id', authMiddleware, validateParams(problemIdParamsSchema), asyncHandler(controller.getProblemById));
router.post('/problems', authMiddleware, validateBody(problemCreateSchema), asyncHandler(controller.createProblem));
// Static PATCH paths must precede /problems/:id to avoid being treated as IDs.
router.patch('/problems/bulk-status', authMiddleware, validateBody(bulkUpdateSchema), asyncHandler(controller.bulkUpdateStatus));
router.patch('/problems/:id', authMiddleware, validateParams(problemIdParamsSchema), validateBody(problemUpdateSchema), asyncHandler(controller.updateProblem));
router.delete('/problems/:id', authMiddleware, validateParams(problemIdParamsSchema), asyncHandler(controller.deleteProblem));
router.post('/problems/:id/favorite', authMiddleware, validateParams(problemIdParamsSchema), asyncHandler(controller.toggleFavorite));
router.get('/stats', authMiddleware, asyncHandler(controller.getStats));
router.get('/dashboard', authMiddleware, asyncHandler(controller.getDashboard));
router.get('/heatmap', authMiddleware, asyncHandler(controller.getHeatmap));
router.get('/submissions', authMiddleware, asyncHandler(controller.getSubmissions));
router.get('/contests', authMiddleware, asyncHandler(controller.getContests));
router.get('/topics', authMiddleware, asyncHandler(controller.getTopicAnalytics));

export default router;
