// src/modules/dsa/dsa.controller.ts
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import * as service from './dsa.service.js';
import { successResponse, commonErrors, deleteResponse, mutationResponse } from '../../shared/response.js';

export async function getProblems(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = req.query as Record<string, string | undefined>;
  const data = await service.getProblems(req.user!.id, {
    difficulty: filters.difficulty as 'easy' | 'medium' | 'hard',
    status: filters.status as 'unsolved' | 'attempted' | 'solved' | 'revisit',
    category: filters.category,
    platform: filters.platform,
    tags: filters.tags?.split(','),
    isFavorite: filters.isFavorite === 'true' ? true : filters.isFavorite === 'false' ? false : undefined,
    search: filters.search,
    sortBy: filters.sortBy as 'title' | 'difficulty' | 'lastSubmittedAt' | 'solvedAt' | 'timeTaken',
    sortOrder: filters.sortOrder as 'asc' | 'desc',
    page: filters.page ? parseInt(filters.page) : undefined,
    pageSize: filters.pageSize ? parseInt(filters.pageSize) : undefined,
  });
  successResponse(res, data, 'Problems retrieved successfully');
}

export async function getProblemById(req: AuthenticatedRequest, res: Response): Promise<void> {
  const problem = await service.getProblemById(req.user!.id, req.params.id as string);
  if (!problem) {
    commonErrors.notFound(res, 'Problem');
    return;
  }
  successResponse(res, problem, 'Problem retrieved successfully');
}

export async function createProblem(req: AuthenticatedRequest, res: Response): Promise<void> {
  const problem = await service.createProblem(req.user!.id, req.body);
  successResponse(res, problem, 'Problem created successfully', 201);
}

export async function updateProblem(req: AuthenticatedRequest, res: Response): Promise<void> {
  const problem = await service.updateProblem(req.user!.id, req.params.id as string, req.body);
  if (!problem) {
    commonErrors.notFound(res, 'Problem');
    return;
  }
  successResponse(res, problem, 'Problem updated successfully');
}

export async function deleteProblem(req: AuthenticatedRequest, res: Response): Promise<void> {
  const deleted = await service.deleteProblem(req.user!.id, req.params.id as string);
  if (!deleted) {
    commonErrors.notFound(res, 'Problem');
    return;
  }
  deleteResponse(res, req.params.id as string, 'Problem deleted successfully');
}

export async function toggleFavorite(req: AuthenticatedRequest, res: Response): Promise<void> {
  const problem = await service.toggleFavorite(req.user!.id, req.params.id as string);
  if (!problem) {
    commonErrors.notFound(res, 'Problem');
    return;
  }
  successResponse(res, problem, 'Favorite toggled successfully');
}

export async function bulkUpdateStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { problemIds, status } = req.body;
  const updated = await service.bulkUpdateStatus(req.user!.id, problemIds, status);
  mutationResponse(res, true, `${updated} problems updated successfully`);
}

export async function getStats(req: AuthenticatedRequest, res: Response): Promise<void> {
  const stats = await service.getStats(req.user!.id);
  successResponse(res, stats, 'Stats retrieved successfully');
}

export async function getDashboard(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await service.getDashboard(req.user!.id);
  successResponse(res, data, 'Dashboard data retrieved successfully');
}

export async function getHeatmap(req: AuthenticatedRequest, res: Response): Promise<void> {
  const year = req.query.year ? parseInt(req.query.year as string, 10) : undefined;
  const data = await service.getHeatmap(req.user!.id, year);
  successResponse(res, data, 'Heatmap data retrieved successfully');
}

export async function getSubmissions(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = {
    platform: req.query.platform as string | undefined,
    status: req.query.status as string | undefined,
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
  };
  const data = await service.getSubmissions(req.user!.id, filters);
  successResponse(res, data, 'Submissions retrieved successfully');
}

export async function getContests(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = {
    platform: req.query.platform as string | undefined,
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
  };
  const data = await service.getContests(req.user!.id, filters);
  successResponse(res, data, 'Contests retrieved successfully');
}

export async function getTopicAnalytics(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await service.getTopicAnalytics(req.user!.id);
  successResponse(res, data, 'Topic analytics retrieved successfully');
}

export async function getDistribution(req: AuthenticatedRequest, res: Response): Promise<void> {
  const data = await service.getProblemDistribution(req.user!.id);
  successResponse(res, data, 'Problem distribution retrieved successfully');
}