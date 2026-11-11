// src/modules/projects/projects.service.ts
import { Types } from 'mongoose';
import { Project, ProjectTask, ActivityEvent } from '../../db/models/index.js';
import { rankBetween } from '../../db/models/projectTask.model.js';
import { createActivity } from '../activity/activity.service.js';
import { logger } from '../../shared/logger.js';
import type {
  ApiProjectListResponse,
  ApiProject,
  ApiProjectTask,
  ApiProjectStats,
  ApiProjectFilters,
  ApiProjectCreatePayload,
  ApiProjectUpdatePayload,
  ApiPagination,
  ApiProjectCommitDay,
} from '../../types/api.types.js';
import { parsePaginationParams, createPagination, getSkipCount, buildSortOptions } from '../../shared/pagination.js';
import { parseGitHubRepositoryUrl, fetchGitHubProjectMetrics } from './project-github-sync.js';

const ALLOWED_SORT_FIELDS = ['name', 'createdAt', 'updatedAt', 'stars', 'lastCommitAt'];

export async function getProjects(userId: string, filters: ApiProjectFilters): Promise<ApiProjectListResponse> {
  const { page, pageSize } = parsePaginationParams({
    page: filters.page?.toString(),
    pageSize: filters.pageSize?.toString(),
  });

  const query: Record<string, unknown> = { userId: new Types.ObjectId(userId) };

  if (filters.status) query.status = filters.status;
  if (filters.visibility) query.visibility = filters.visibility;
  if (filters.language) query.language = filters.language;
  if (filters.search) {
    query.$or = [
      { name: { $regex: filters.search, $options: 'i' } },
      { description: { $regex: filters.search, $options: 'i' } },
    ];
  }

  const skip = getSkipCount({ page, pageSize });
  const sort = buildSortOptions(filters.sortBy, filters.sortOrder, ALLOWED_SORT_FIELDS);

  const [projects, totalCount] = await Promise.all([
    Project.find(query).sort(sort).skip(skip).limit(pageSize).lean(),
    Project.countDocuments(query),
  ]);

  const stats = await getProjectStats(userId);
  const pagination: ApiPagination = createPagination(totalCount, { page, pageSize });

  return {
    projects: projects.map(mapProjectToApi),
    pagination,
    stats,
  };
}

export async function getProjectById(userId: string, projectId: string): Promise<ApiProject | null> {
  const project = await Project.findOne({
    _id: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  }).lean();

  return project ? mapProjectToApi(project) : null;
}

export async function createProject(userId: string, payload: ApiProjectCreatePayload): Promise<ApiProject> {
  const project = await Project.create({
    userId: new Types.ObjectId(userId),
    ...payload,
    stars: 0,
    forks: 0,
    totalCommits: 0,
    totalPullRequests: 0,
    totalIssues: 0,
    openIssues: 0,
  });

  // Activity logging
  createActivity(userId, {
    type: 'project_created',
    title: `Created project ${payload.name}`,
    description: payload.description || '',
    platform: 'devtrack',
    url: payload.repoUrl ?? null,
    tags: ['project', 'create'],
    metadata: {
      projectId: project._id.toString(),
      projectName: payload.name,
      status: payload.status,
    },
  }).catch((err: unknown) => {
    logger.warn('Failed to log project create activity', { error: err instanceof Error ? err.message : String(err) });
  });

  return mapProjectToApi(project.toObject() as unknown as Record<string, unknown> & { _id: { toString(): string } });
}

export async function updateProject(
  userId: string,
  projectId: string,
  payload: ApiProjectUpdatePayload
): Promise<ApiProject | null> {
  const project = await Project.findOneAndUpdate(
    { _id: new Types.ObjectId(projectId), userId: new Types.ObjectId(userId) },
    payload,
    { new: true }
  ).lean();

  if (project) {
    // Build a human-readable description of what changed
    const changes: string[] = [];
    if (payload.name) changes.push(`renamed to "${payload.name}"`);
    if (payload.status) changes.push(`status → ${payload.status}`);
    if (payload.visibility) changes.push(`visibility → ${payload.visibility}`);
    if (payload.techStack) changes.push('updated tech stack');
    const desc = changes.length > 0 ? changes.join(', ') : 'updated project details';

    createActivity(userId, {
      type: 'project_updated',
      title: `Updated project ${project.name}`,
      description: desc,
      platform: 'devtrack',
      url: (project.repoUrl as string) ?? null,
      tags: ['project', 'update'],
      metadata: {
        projectId,
        projectName: project.name as string,
      },
    }).catch((err: unknown) => {
      logger.warn('Failed to log project update activity', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  return project ? mapProjectToApi(project) : null;
}

export async function deleteProject(userId: string, projectId: string): Promise<boolean> {
  // Read project name before deleting
  const project = await Project.findOne({
    _id: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  }).lean();

  if (!project) return false;

  // Delete associated tasks first
  await ProjectTask.deleteMany({ projectId: new Types.ObjectId(projectId) });

  const result = await Project.deleteOne({
    _id: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  });

  if (result.deletedCount > 0) {
    createActivity(userId, {
      type: 'project_deleted',
      title: `Deleted project ${project.name}`,
      description: `Removed project "${project.name}" and its tasks`,
      platform: 'devtrack',
      url: null,
      tags: ['project', 'delete'],
      metadata: {
        projectId,
        projectName: project.name,
      },
    }).catch((err: unknown) => {
      logger.warn('Failed to log project delete activity', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  return result.deletedCount > 0;
}

export async function getProjectStats(userId: string): Promise<ApiProjectStats> {
  const stats = await Project.aggregate([
    { $match: { userId: new Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalProjects: { $sum: 1 },
        activeProjects: { $sum: { $cond: [{ $eq: ['$status', 'in_progress'] }, 1, 0] } },
        completedProjects: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        totalCommits: { $sum: '$totalCommits' },
        totalPullRequests: { $sum: '$totalPullRequests' },
        totalIssues: { $sum: '$totalIssues' },
        languages: { $push: '$language' },
      },
    },
  ]);

  const data = stats[0] || {
    totalProjects: 0,
    activeProjects: 0,
    completedProjects: 0,
    totalCommits: 0,
    totalPullRequests: 0,
    totalIssues: 0,
    languages: [],
  };

  // Calculate language distribution
  const languageDistribution: Record<string, number> = {};
  data.languages?.forEach((lang: string) => {
    if (lang) {
      languageDistribution[lang] = (languageDistribution[lang] || 0) + 1;
    }
  });

  // Get commit history for last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const commitEvents = await ActivityEvent.aggregate([
    {
      $match: {
        userId: new Types.ObjectId(userId),
        type: 'commit',
        occurredAt: { $gte: thirtyDaysAgo },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const commitHistory: ApiProjectCommitDay[] = commitEvents.map((event) => ({
    date: event._id,
    count: event.count,
  }));

  return {
    totalProjects: data.totalProjects,
    activeProjects: data.activeProjects,
    completedProjects: data.completedProjects,
    totalCommits: data.totalCommits,
    totalPullRequests: data.totalPullRequests,
    totalIssues: data.totalIssues,
    languageDistribution,
    commitHistory,
  };
}

export async function getProjectTasks(userId: string, projectId: string): Promise<ApiProjectTask[]> {
  // Verify project exists and belongs to user
  const project = await Project.findOne({
    _id: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  });

  if (!project) return [];

  const tasks = await ProjectTask.find({ projectId: new Types.ObjectId(projectId) }).sort({ rank: 1, createdAt: -1, _id: 1 });

  return tasks.map((task) => ({
    id: task._id.toString(),
    projectId: task.projectId.toString(),
    milestoneId: task.milestoneId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    labels: task.labels,
    dueDate: task.dueDate?.toISOString() || null,
    completedAt: task.completedAt?.toISOString() || null,
    rank: task.rank ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }));
}

export async function createProjectTask(
  userId: string,
  projectId: string,
  payload: Omit<ApiProjectTask, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'completedAt' | 'rank'>
): Promise<ApiProjectTask | null> {
  // Verify project exists and belongs to user
  const project = await Project.findOne({
    _id: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  });

  if (!project) return null;

  // New tasks go to the bottom of their column
  const last = await ProjectTask.findOne({
    projectId: new Types.ObjectId(projectId),
    status: payload.status,
    rank: { $ne: null },
  }).sort({ rank: -1 });

  const task = await ProjectTask.create({
    projectId: new Types.ObjectId(projectId),
    ...payload,
    rank: rankBetween(last?.rank ?? null, null),
    completedAt: payload.status === 'done' ? new Date() : null,
  });

  return {
    id: task._id.toString(),
    projectId: task.projectId.toString(),
    milestoneId: task.milestoneId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    labels: task.labels,
    dueDate: task.dueDate?.toISOString() || null,
    completedAt: task.completedAt?.toISOString() || null,
    rank: task.rank ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export async function updateProjectTask(
  userId: string,
  projectId: string,
  taskId: string,
  input: Partial<Pick<ApiProjectTask, 'status' | 'title' | 'description' | 'priority' | 'labels' | 'dueDate'>> & {
    /** Rank of the card that will sit above the moved task (null = top of the column) */
    prevRank?: string | null;
    /** Rank of the card that will sit below the moved task (null = bottom of the column) */
    nextRank?: string | null;
  }
): Promise<ApiProjectTask | null> {
  const { prevRank, nextRank, ...fields } = input;
  // Moving a card is one $set on that card: the new column plus a rank between its new neighbours.
  const payload: typeof fields & { rank?: string } = { ...fields };
  if (prevRank !== undefined || nextRank !== undefined) {
    payload.rank = rankBetween(prevRank ?? null, nextRank ?? null);
  }

  // Verify project exists and belongs to user
  const project = await Project.findOne({
    _id: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  });

  if (!project) return null;

  let update: Record<string, unknown> | Record<string, unknown>[] = { ...payload };
  if (payload.status === 'done') {
    // The pipeline reads the current status at write time, so concurrent edits
    // cannot leave the timestamp out of step with the status.
    const fields = Object.fromEntries(Object.entries(payload).map(([key, value]) => [
      key,
      { $literal: key === 'dueDate' && value !== null ? new Date(value as string) : value },
    ]));
    update = [{ $set: {
      ...fields,
      completedAt: {
        $cond: [
          { $eq: ['$status', 'done'] },
          { $ifNull: ['$completedAt', new Date()] },
          new Date(),
        ],
      },
    } }];
  } else if (payload.status) {
    update.completedAt = null;
  }

  const task = await ProjectTask.findOneAndUpdate(
    { _id: new Types.ObjectId(taskId), projectId: new Types.ObjectId(projectId) },
    update,
    { new: true }
  );

  if (!task) return null;

  return {
    id: task._id.toString(),
    projectId: task.projectId.toString(),
    milestoneId: task.milestoneId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    labels: task.labels,
    dueDate: task.dueDate?.toISOString() || null,
    completedAt: task.completedAt?.toISOString() || null,
    rank: task.rank ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export async function deleteProjectTask(
  userId: string,
  projectId: string,
  taskId: string
): Promise<boolean> {
  const project = await Project.findOne({
    _id: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  }).select('_id').lean();

  if (!project) return false;

  const task = await ProjectTask.findOneAndDelete({
    _id: new Types.ObjectId(taskId),
    projectId: new Types.ObjectId(projectId),
  });

  return Boolean(task);
}

export type ProjectSyncResult = 'synced' | 'not_found' | 'unsupported_repo' | 'upstream_error' | 'repo_changed';

export async function syncProject(userId: string, projectId: string): Promise<ProjectSyncResult> {
  const project = await Project.findOne({
    _id: new Types.ObjectId(projectId),
    userId: new Types.ObjectId(userId),
  });

  if (!project) return 'not_found';
  const repository = parseGitHubRepositoryUrl(project.repoUrl);
  if (!repository) return 'unsupported_repo';

  let metrics;
  try {
    metrics = await fetchGitHubProjectMetrics(repository);
  } catch (error) {
    logger.warn('Project GitHub sync failed', { projectId, error: error instanceof Error ? error.message : String(error) });
    return 'upstream_error';
  }

  const updated = await Project.findOneAndUpdate(
    { _id: project._id, userId: project.userId, repoUrl: project.repoUrl },
    { $set: metrics },
    { new: true }
  );
  return updated ? 'synced' : 'repo_changed';
}

function mapProjectToApi(project: Record<string, unknown> & { _id: { toString(): string } }): ApiProject {
  return {
    id: (project._id as Types.ObjectId).toString(),
    name: project.name as string,
    description: project.description as string,
    repoUrl: (project.repoUrl as string) || null,
    liveUrl: (project.liveUrl as string) || null,
    techStack: (project.techStack as string[]) || [],
    status: project.status as ApiProject['status'],
    visibility: project.visibility as ApiProject['visibility'],
    thumbnailUrl: (project.thumbnailUrl as string) || null,
    stars: (project.stars as number) || 0,
    forks: (project.forks as number) || 0,
    language: (project.language as string) || '',
    totalCommits: (project.totalCommits as number) || 0,
    totalPullRequests: (project.totalPullRequests as number) || 0,
    totalIssues: (project.totalIssues as number) || 0,
    openIssues: (project.openIssues as number) || 0,
    lastCommitAt: project.lastCommitAt ? (project.lastCommitAt as Date).toISOString() : null,
    lastCommitMessage: (project.lastCommitMessage as string) || null,
    contributors: (project.contributors as ApiProject['contributors']) || [],
    milestones: (project.milestones as ApiProject['milestones']) || [],
    createdAt: (project.createdAt as Date).toISOString(),
    updatedAt: (project.updatedAt as Date).toISOString(),
  };
}
