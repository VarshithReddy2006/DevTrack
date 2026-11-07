// ============================================================================
// projectsService.ts — Projects API Service
// ============================================================================
// HTTP-only. Returns raw API types. No transformations.
// ============================================================================

import axiosClient from '../utils/axiosClient';
import type {
  ApiResponse,
  ApiProjectListResponse,
  ApiProject,
  ApiProjectStats,
  ApiProjectTask,
  ApiProjectFilters,
  ApiProjectCreatePayload,
  ApiProjectUpdatePayload,
  ApiMutationResponse,
  ApiDeleteResponse,
} from '../types/api.types';

const PROJECTS_BASE = '/projects';

/**
 * Fetch paginated project list with filters and stats.
 */
export async function fetchProjects(
  filters: ApiProjectFilters = {},
  options?: { signal?: AbortSignal }
): Promise<ApiResponse<ApiProjectListResponse>> {
  const { data } = await axiosClient.get<ApiResponse<ApiProjectListResponse>>(
    `${PROJECTS_BASE}`,
    { params: filters, signal: options?.signal }
  );
  return data;
}

/**
 * Fetch a single project by ID with full details.
 */
export async function fetchProject(
  projectId: string,
  options?: { signal?: AbortSignal }
): Promise<ApiResponse<ApiProject>> {
  const { data } = await axiosClient.get<ApiResponse<ApiProject>>(
    `${PROJECTS_BASE}/${projectId}`,
    { signal: options?.signal }
  );
  return data;
}

/**
 * Fetch project stats/overview.
 */
export async function fetchProjectStats(): Promise<ApiResponse<ApiProjectStats>> {
  const { data } = await axiosClient.get<ApiResponse<ApiProjectStats>>(
    `${PROJECTS_BASE}/stats`
  );
  return data;
}

/**
 * Create a new project.
 */
export async function createProject(
  payload: ApiProjectCreatePayload
): Promise<ApiResponse<ApiProject>> {
  const { data } = await axiosClient.post<ApiResponse<ApiProject>>(
    `${PROJECTS_BASE}`,
    payload
  );
  return data;
}

/**
 * Update an existing project.
 */
export async function updateProject(
  projectId: string,
  payload: ApiProjectUpdatePayload
): Promise<ApiResponse<ApiProject>> {
  const { data } = await axiosClient.patch<ApiResponse<ApiProject>>(
    `${PROJECTS_BASE}/${projectId}`,
    payload
  );
  return data;
}

/**
 * Delete a project.
 */
export async function deleteProject(
  projectId: string
): Promise<ApiDeleteResponse> {
  const { data } = await axiosClient.delete<ApiDeleteResponse>(
    `${PROJECTS_BASE}/${projectId}`
  );
  return data;
}

/**
 * Fetch tasks for a project.
 */
export async function fetchProjectTasks(
  projectId: string,
  options?: { signal?: AbortSignal }
): Promise<ApiResponse<ApiProjectTask[]>> {
  const { data } = await axiosClient.get<ApiResponse<ApiProjectTask[]>>(
    `${PROJECTS_BASE}/${projectId}/tasks`,
    { signal: options?.signal }
  );
  return data;
}

/**
 * Create a task within a project.
 */
export async function createProjectTask(
  projectId: string,
  payload: Omit<ApiProjectTask, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'completedAt'>
): Promise<ApiResponse<ApiProjectTask>> {
  const { data } = await axiosClient.post<ApiResponse<ApiProjectTask>>(
    `${PROJECTS_BASE}/${projectId}/tasks`,
    payload
  );
  return data;
}

/**
 * Update a task's status.
 */
export async function updateProjectTask(
  projectId: string,
  taskId: string,
  payload: Partial<Pick<ApiProjectTask, 'status' | 'title' | 'description' | 'priority' | 'labels' | 'dueDate'>>
): Promise<ApiResponse<ApiProjectTask>> {
  const { data } = await axiosClient.patch<ApiResponse<ApiProjectTask>>(
    `${PROJECTS_BASE}/${projectId}/tasks/${taskId}`,
    payload
  );
  return data;
}

/**
 * Delete a task from a project.
 */
export async function deleteProjectTask(
  projectId: string,
  taskId: string
): Promise<ApiDeleteResponse> {
  const { data } = await axiosClient.delete<ApiDeleteResponse>(
    `${PROJECTS_BASE}/${projectId}/tasks/${taskId}`
  );
  return data;
}

/**
 * Trigger a sync of project data from GitHub.
 */
export async function syncProject(
  projectId: string
): Promise<ApiMutationResponse> {
  const { data } = await axiosClient.post<ApiMutationResponse>(
    `${PROJECTS_BASE}/${projectId}/sync`
  );
  return data;
}
