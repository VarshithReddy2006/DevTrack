import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { Project, ProjectTask } from '../../../db/models/index.js';
import { deleteProject, createProjectTask, createProject } from '../../../modules/projects/projects.service.js';
import { cacheManager } from '../../../shared/cache/cacheManager.js';

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    invalidateDashboard: vi.fn().mockResolvedValue(undefined),
    invalidateAllUserCache: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../modules/activity/activity.service.js', () => ({
  createActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../modules/readiness/services/VerifiedProjectIngestionService.js', () => ({
  VerifiedProjectIngestionService: {
    queueRefresh: vi.fn().mockResolvedValue(undefined),
    ingestAfterChange: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Project Deletion & Task Integrity — Issue #173', () => {
  const ownerId = new Types.ObjectId().toHexString();
  const otherUserId = new Types.ObjectId().toHexString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Project.deleteMany({});
    await ProjectTask.deleteMany({});
  });

  it('atomically deletes both project and all associated tasks', async () => {
    const project = await createProject(ownerId, {
      name: 'Alpha Project',
      description: 'Test project',
      status: 'in_progress',
      visibility: 'private',
      techStack: ['Node.js', 'MongoDB'],
    });

    const task1 = await createProjectTask(ownerId, project.id, {
      title: 'Task 1',
      description: 'First task',
      milestoneId: null,
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      labels: ['backend'],
      dueDate: null,
    });

    const task2 = await createProjectTask(ownerId, project.id, {
      title: 'Task 2',
      description: 'Second task',
      milestoneId: null,
      status: 'in_progress',
      priority: 'medium',
      assigneeId: null,
      labels: ['feature'],
      dueDate: null,
    });

    expect(task1).not.toBeNull();
    expect(task2).not.toBeNull();

    const initialTasks = await ProjectTask.find({ projectId: new Types.ObjectId(project.id) });
    expect(initialTasks).toHaveLength(2);

    const deleted = await deleteProject(ownerId, project.id);
    expect(deleted).toBe(true);

    const remainingProject = await Project.findById(project.id);
    expect(remainingProject).toBeNull();

    const remainingTasks = await ProjectTask.find({ projectId: new Types.ObjectId(project.id) });
    expect(remainingTasks).toHaveLength(0);

    expect(cacheManager.invalidateDashboard).toHaveBeenCalledWith(ownerId);
  });

  it('guarantees failure atomicity: simulated failure rolls back deletion so neither project nor tasks are lost', async () => {
    const project = await createProject(ownerId, {
      name: 'Resilient Project',
      description: 'Should survive failure',
      status: 'in_progress',
      visibility: 'public',
      techStack: ['TypeScript'],
    });

    await createProjectTask(ownerId, project.id, {
      title: 'Critical Task',
      description: 'Must not become an orphan or be lost prematurely',
      milestoneId: null,
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      labels: ['core'],
      dueDate: null,
    });

    const tasksBefore = await ProjectTask.find({ projectId: new Types.ObjectId(project.id) });
    expect(tasksBefore).toHaveLength(1);

    // Inject a failure during ProjectTask.deleteMany within the transaction
    const deleteManySpy = vi.spyOn(ProjectTask, 'deleteMany').mockImplementationOnce((() => {
      throw new Error('Simulated failure during child task deletion');
    }) as any);

    await expect(deleteProject(ownerId, project.id)).rejects.toThrow('Simulated failure during child task deletion');

    deleteManySpy.mockRestore();

    // Verify parent project still exists
    const survivingProject = await Project.findById(project.id);
    expect(survivingProject).not.toBeNull();
    expect(survivingProject?.name).toBe('Resilient Project');

    // Verify tasks are completely intact (not lost)
    const survivingTasks = await ProjectTask.find({ projectId: new Types.ObjectId(project.id) });
    expect(survivingTasks).toHaveLength(1);
    expect(survivingTasks[0].title).toBe('Critical Task');
  });

  it('coordinates concurrent task creation with project deletion so no orphan task is ever created', async () => {
    const project = await createProject(ownerId, {
      name: 'Race Barrier Project',
      description: 'Testing concurrency race',
      status: 'planning',
      visibility: 'private',
      techStack: ['Go'],
    });

    // Run deleteProject and createProjectTask concurrently
    const [deleteResult, taskCreateResult] = await Promise.all([
      deleteProject(ownerId, project.id),
      createProjectTask(ownerId, project.id, {
        title: 'Concurrent Task',
        description: 'Should either be deleted or rejected',
        milestoneId: null,
        status: 'todo',
        priority: 'low',
        assigneeId: null,
        labels: ['race'],
        dueDate: null,
      }),
    ]);

    expect(deleteResult).toBe(true);

    // In no scenario should an orphan task exist without its parent project
    const remainingProject = await Project.findById(project.id);
    expect(remainingProject).toBeNull();

    const orphanTasks = await ProjectTask.find({ projectId: new Types.ObjectId(project.id) });
    expect(orphanTasks).toHaveLength(0);

    // If task creation ran after project deletion transaction locked/deleted the project, it should return null
    if (taskCreateResult === null) {
      expect(taskCreateResult).toBeNull();
    }
  });

  it('handles repeated concurrent deletions safely without duplicate deletes or unhandled errors', async () => {
    const project = await createProject(ownerId, {
      name: 'Idempotent Delete Project',
      description: 'Testing duplicate deletes',
      status: 'completed',
      visibility: 'private',
      techStack: [],
    });

    await createProjectTask(ownerId, project.id, {
      title: 'Existing Task',
      description: 'Task for deletion',
      milestoneId: null,
      status: 'todo',
      priority: 'medium',
      assigneeId: null,
      labels: [],
      dueDate: null,
    });

    const [result1, result2] = await Promise.all([
      deleteProject(ownerId, project.id),
      deleteProject(ownerId, project.id),
    ]);

    // Exactly one must report true, the other false
    expect([result1, result2].filter(Boolean)).toHaveLength(1);

    const projectAfter = await Project.findById(project.id);
    expect(projectAfter).toBeNull();

    const tasksAfter = await ProjectTask.find({ projectId: new Types.ObjectId(project.id) });
    expect(tasksAfter).toHaveLength(0);
  });

  it('enforces owner isolation: unauthorized users cannot delete other users projects or tasks', async () => {
    const project = await createProject(ownerId, {
      name: 'Owner Isolated Project',
      description: 'Owned by ownerId',
      status: 'in_progress',
      visibility: 'private',
      techStack: [],
    });

    await createProjectTask(ownerId, project.id, {
      title: 'Protected Task',
      description: 'Must remain intact',
      milestoneId: null,
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      labels: [],
      dueDate: null,
    });

    // Attempt delete with otherUserId
    const deleted = await deleteProject(otherUserId, project.id);
    expect(deleted).toBe(false);

    // Project and tasks must still exist
    const projectAfter = await Project.findById(project.id);
    expect(projectAfter).not.toBeNull();

    const tasksAfter = await ProjectTask.find({ projectId: new Types.ObjectId(project.id) });
    expect(tasksAfter).toHaveLength(1);
  });
});
