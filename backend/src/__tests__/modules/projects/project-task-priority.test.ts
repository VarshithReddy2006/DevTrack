// src/__tests__/modules/projects/project-task-priority.test.ts
// Unit tests for project task priority filtering and overdue task detection

import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { Project, ProjectTask } from '../../../db/models/index.js';
import { getProjectTasks, getOverdueTasks } from '../../../modules/projects/projects.service.js';

describe('Project Task Priority & Overdue Detection', () => {
  const userId = new Types.ObjectId().toHexString();
  const foreignUserId = new Types.ObjectId().toHexString();
  let projectId: string;
  let foreignProjectId: string;

  beforeEach(async () => {
    await Project.deleteMany({});
    await ProjectTask.deleteMany({});

    const [project, foreignProject] = await Project.create([
      {
        userId: new Types.ObjectId(userId),
        name: 'User Project',
        description: 'Testing tasks',
        techStack: ['TypeScript', 'Node.js'],
        status: 'in_progress',
        visibility: 'private',
      },
      {
        userId: new Types.ObjectId(foreignUserId),
        name: 'Foreign Project',
        description: 'Foreign',
        techStack: ['Python'],
        status: 'in_progress',
        visibility: 'private',
      },
    ]);

    projectId = project._id.toString();
    foreignProjectId = foreignProject._id.toString();
  });

  it('filters project tasks by priority', async () => {
    await ProjectTask.create([
      {
        projectId: new Types.ObjectId(projectId),
        title: 'High priority task',
        description: 'Important',
        status: 'todo',
        priority: 'high',
      },
      {
        projectId: new Types.ObjectId(projectId),
        title: 'Low priority task',
        description: 'Minor',
        status: 'in_progress',
        priority: 'low',
      },
      {
        projectId: new Types.ObjectId(projectId),
        title: 'Critical task',
        description: 'Urgent',
        status: 'todo',
        priority: 'critical',
      },
    ]);

    const highTasks = await getProjectTasks(userId, projectId, { priority: 'high' });
    expect(highTasks).toHaveLength(1);
    expect(highTasks[0].title).toBe('High priority task');
    expect(highTasks[0].priority).toBe('high');

    const lowTasks = await getProjectTasks(userId, projectId, { priority: 'low' });
    expect(lowTasks).toHaveLength(1);
    expect(lowTasks[0].title).toBe('Low priority task');

    const allTasks = await getProjectTasks(userId, projectId);
    expect(allTasks).toHaveLength(3);
  });

  it('filters project tasks by status and computes isOverdue flag', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await ProjectTask.create([
      {
        projectId: new Types.ObjectId(projectId),
        title: 'Overdue Todo Task',
        description: 'Missed deadline',
        status: 'todo',
        priority: 'high',
        dueDate: yesterday,
      },
      {
        projectId: new Types.ObjectId(projectId),
        title: 'Future In-Progress Task',
        description: 'Still on time',
        status: 'in_progress',
        priority: 'medium',
        dueDate: tomorrow,
      },
      {
        projectId: new Types.ObjectId(projectId),
        title: 'Done Task Past Due',
        description: 'Finished successfully',
        status: 'done',
        priority: 'high',
        dueDate: yesterday,
        completedAt: yesterday,
      },
    ]);

    const tasks = await getProjectTasks(userId, projectId);
    expect(tasks).toHaveLength(3);

    const overdueTodo = tasks.find((t) => t.title === 'Overdue Todo Task');
    expect(overdueTodo?.isOverdue).toBe(true);

    const futureTask = tasks.find((t) => t.title === 'Future In-Progress Task');
    expect(futureTask?.isOverdue).toBe(false);

    // Completed task should not be overdue even if dueDate is past
    const doneTask = tasks.find((t) => t.title === 'Done Task Past Due');
    expect(doneTask?.isOverdue).toBe(false);
  });

  it('retrieves overdue tasks exclusively via getOverdueTasks', async () => {
    const past = new Date(Date.now() - 10 * 60 * 1000);
    const future = new Date(Date.now() + 10 * 60 * 1000);

    await ProjectTask.create([
      {
        projectId: new Types.ObjectId(projectId),
        title: 'Overdue Task 1',
        description: 'Needs attention',
        status: 'todo',
        priority: 'critical',
        dueDate: past,
      },
      {
        projectId: new Types.ObjectId(projectId),
        title: 'Upcoming Task',
        description: 'Not due yet',
        status: 'todo',
        priority: 'medium',
        dueDate: future,
      },
      {
        projectId: new Types.ObjectId(projectId),
        title: 'Done Overdue',
        description: 'Done',
        status: 'done',
        priority: 'low',
        dueDate: past,
      },
    ]);

    const overdue = await getOverdueTasks(userId, projectId);
    expect(overdue).toHaveLength(1);
    expect(overdue[0].title).toBe('Overdue Task 1');
    expect(overdue[0].isOverdue).toBe(true);
  });

  it('enforces ownership check on project tasks', async () => {
    const tasks = await getProjectTasks(userId, foreignProjectId);
    expect(tasks).toEqual([]);

    const overdue = await getOverdueTasks(userId, foreignProjectId);
    expect(overdue).toEqual([]);
  });
});
