// src/modules/projects/projects.routes.ts
import { Router } from 'express';
import { asyncHandler, authMiddleware, validateBody } from '../../middleware/index.js';
import { validateParams, validateQuery, objectIdSchema } from '../../middleware/validation.js';
import * as controller from './projects.controller.js';
import { z } from 'zod';

const router = Router();

const projectCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  repoUrl: z.string().url().optional(),
  liveUrl: z.string().url().optional(),
  techStack: z.array(z.string()),
  status: z.enum(['planning', 'in_progress', 'completed', 'on_hold', 'archived']),
  visibility: z.enum(['public', 'private']),
});

const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  repoUrl: z.string().url().optional().nullable(),
  liveUrl: z.string().url().optional().nullable(),
  techStack: z.array(z.string()).optional(),
  status: z.enum(['planning', 'in_progress', 'completed', 'on_hold', 'archived']).optional(),
  visibility: z.enum(['public', 'private']).optional(),
});

const taskCreateSchema = z.object({
  milestoneId: z.string().nullable().optional(),
  title: z.string().min(1),
  description: z.string(),
  status: z.enum(['todo', 'in_progress', 'review', 'done']),
  priority: z.enum(['low', 'medium', 'high', 'critical']),
  assigneeId: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  dueDate: z.string().nullable().optional(),
});

const taskUpdateSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  labels: z.array(z.string()).optional(),
  dueDate: z.string().nullable().optional(),
  // Ranks of the cards the task is dropped between (null = open end of the column)
  prevRank: z.string().regex(/^[0-9A-Za-z]*[1-9A-Za-z]$/).nullable().optional(),
  nextRank: z.string().regex(/^[0-9A-Za-z]*[1-9A-Za-z]$/).nullable().optional(),
}).refine(
  (value) => !value.prevRank || !value.nextRank || value.prevRank < value.nextRank,
  { message: 'prevRank must sort before nextRank', path: ['prevRank'] }
);

const projectIdParamsSchema = z.object({ id: objectIdSchema });
const taskParamsSchema = z.object({ id: objectIdSchema, taskId: objectIdSchema });
const taskQuerySchema = z.object({
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  status: z.enum(['todo', 'in_progress', 'review', 'done']).optional(),
  milestoneId: z.string().min(1).optional(),
  overdueOnly: z.enum(['true', 'false']).optional(),
});

router.get('/', authMiddleware, asyncHandler(controller.getProjects));
router.get('/stats', authMiddleware, asyncHandler(controller.getProjectStats));
router.post('/', authMiddleware, validateBody(projectCreateSchema), asyncHandler(controller.createProject));
router.get('/:id', authMiddleware, validateParams(projectIdParamsSchema), asyncHandler(controller.getProjectById));
router.patch('/:id', authMiddleware, validateParams(projectIdParamsSchema), validateBody(projectUpdateSchema), asyncHandler(controller.updateProject));
router.delete('/:id', authMiddleware, validateParams(projectIdParamsSchema), asyncHandler(controller.deleteProject));
router.get('/:id/tasks', authMiddleware, validateParams(projectIdParamsSchema), validateQuery(taskQuerySchema), asyncHandler(controller.getProjectTasks));
router.get('/:id/tasks/overdue', authMiddleware, validateParams(projectIdParamsSchema), asyncHandler(controller.getOverdueTasks));
router.post('/:id/tasks', authMiddleware, validateParams(projectIdParamsSchema), validateBody(taskCreateSchema), asyncHandler(controller.createProjectTask));
router.patch('/:id/tasks/:taskId', authMiddleware, validateParams(taskParamsSchema), validateBody(taskUpdateSchema), asyncHandler(controller.updateProjectTask));
router.delete('/:id/tasks/:taskId', authMiddleware, validateParams(taskParamsSchema), asyncHandler(controller.deleteProjectTask));
router.post('/:id/sync', authMiddleware, validateParams(projectIdParamsSchema), asyncHandler(controller.syncProject));

export default router;