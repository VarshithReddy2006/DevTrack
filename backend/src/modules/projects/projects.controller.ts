// src/modules/projects/projects.controller.ts
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import * as service from './projects.service.js';
import { successResponse, commonErrors, deleteResponse, mutationResponse, errorResponse } from '../../shared/response.js';

export async function getProjects(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = {
    status: req.query.status as 'planning' | 'in_progress' | 'completed' | 'on_hold' | 'archived',
    visibility: req.query.visibility as 'public' | 'private',
    language: req.query.language as string,
    search: req.query.search as string,
    sortBy: req.query.sortBy as 'name' | 'createdAt' | 'updatedAt' | 'stars' | 'lastCommitAt',
    sortOrder: req.query.sortOrder as 'asc' | 'desc',
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
  };
  const data = await service.getProjects(req.user!.id, filters);
  successResponse(res, data, 'Projects retrieved successfully');
}

export async function getProjectById(req: AuthenticatedRequest, res: Response): Promise<void> {
  const project = await service.getProjectById(req.user!.id, req.params.id as string);
  if (!project) {
    commonErrors.notFound(res, 'Project');
    return;
  }
  successResponse(res, project, 'Project retrieved successfully');
}

export async function createProject(req: AuthenticatedRequest, res: Response): Promise<void> {
  const project = await service.createProject(req.user!.id, req.body);
  successResponse(res, project, 'Project created successfully', 201);
}

export async function updateProject(req: AuthenticatedRequest, res: Response): Promise<void> {
  const project = await service.updateProject(req.user!.id, req.params.id as string, req.body);
  if (!project) {
    commonErrors.notFound(res, 'Project');
    return;
  }
  successResponse(res, project, 'Project updated successfully');
}

export async function deleteProject(req: AuthenticatedRequest, res: Response): Promise<void> {
  const id = req.params.id as string;
  const deleted = await service.deleteProject(req.user!.id, id);
  if (!deleted) {
    commonErrors.notFound(res, 'Project');
    return;
  }
  deleteResponse(res, id, 'Project deleted successfully');
}

export async function getProjectStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  const stats = await service.getProjectStats(req.user!.id);
  successResponse(res, stats, 'Project stats retrieved successfully');
}

export async function getProjectTasks(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters: service.ProjectTaskFilters = {
    priority: typeof req.query.priority === 'string'
      ? req.query.priority as service.ProjectTaskFilters['priority']
      : undefined,
    status: typeof req.query.status === 'string'
      ? req.query.status as service.ProjectTaskFilters['status']
      : undefined,
    milestoneId: typeof req.query.milestoneId === 'string' ? req.query.milestoneId : undefined,
    overdueOnly: req.query.overdueOnly === 'true',
  };
  const tasks = await service.getProjectTasks(req.user!.id, req.params.id as string, filters);
  if (!tasks) {
    commonErrors.notFound(res, 'Project');
    return;
  }
  successResponse(res, tasks, 'Project tasks retrieved successfully');
}

export async function getOverdueTasks(req: AuthenticatedRequest, res: Response): Promise<void> {
  const tasks = await service.getOverdueTasks(req.user!.id, req.params.id as string);
  if (!tasks) {
    commonErrors.notFound(res, 'Project');
    return;
  }
  successResponse(res, tasks, 'Overdue project tasks retrieved successfully');
}

export async function createProjectTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const task = await service.createProjectTask(req.user!.id, req.params.id as string, req.body);
  if (!task) {
    commonErrors.notFound(res, 'Project');
    return;
  }
  successResponse(res, task, 'Task created successfully', 201);
}

export async function updateProjectTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const task = await service.updateProjectTask(req.user!.id, req.params.id as string, req.params.taskId as string, req.body);
  if (!task) {
    commonErrors.notFound(res, 'Task');
    return;
  }
  successResponse(res, task, 'Task updated successfully');
}

export async function deleteProjectTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const projectId = req.params.id as string;
  const taskId = req.params.taskId as string;
  const deleted = await service.deleteProjectTask(req.user!.id, projectId, taskId);

  if (!deleted) {
    commonErrors.notFound(res, 'Task');
    return;
  }

  deleteResponse(res, taskId, 'Task deleted successfully');
}

export async function syncProject(req: AuthenticatedRequest, res: Response): Promise<void> {
  const result = await service.syncProject(req.user!.id, req.params.id as string);
  if (result === 'not_found') {
    commonErrors.notFound(res, 'Project');
    return;
  }
  if (result === 'unsupported_repo') {
    commonErrors.badRequest(res, 'A supported GitHub repository URL is required');
    return;
  }
  if (result === 'upstream_error') {
    errorResponse(res, 'GitHub repository sync failed', 'UPSTREAM_ERROR', 502);
    return;
  }
  if (result === 'repo_changed') {
    commonErrors.conflict(res, 'Project repository changed during sync');
    return;
  }
  mutationResponse(res, true, 'Project synced successfully');
}
