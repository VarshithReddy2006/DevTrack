import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Project, ProjectTask } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import projectsRoutes from '../../../modules/projects/projects.routes.js';

vi.mock('../../../middleware/index.js', async () => {
  const { validateBody, validateParams } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    validateBody,
    validateParams,
    asyncHandler,
    authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.get('authorization') !== 'Bearer test-owner') {
        commonErrors.unauthorized(res);
        return;
      }
      Object.assign(req, { user: { id: '000000000000000000000001' } });
      next();
    },
  };
});

describe('Project task deletion route', () => {
  const ownerId = new Types.ObjectId('000000000000000000000001');
  const otherUserId = new Types.ObjectId('000000000000000000000002');
  let server: Server;
  let baseUrl: string;
  let projectId: string;
  let foreignProjectId: string;
  let taskId: string;
  let taskInOtherProjectId: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectsRoutes);
    app.use(errorHandler);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  });

  beforeEach(async () => {
    const [ownedProject, foreignProject, anotherOwnedProject] = await Project.create([
      { userId: ownerId, name: 'Owned project' },
      { userId: otherUserId, name: 'Foreign project' },
      { userId: ownerId, name: 'Another owned project' },
    ]);
    projectId = ownedProject._id.toString();
    foreignProjectId = foreignProject._id.toString();

    const [ownedTask, taskInOtherProject] = await ProjectTask.create([
      { projectId: ownedProject._id, title: 'Owned task' },
      { projectId: anotherOwnedProject._id, title: 'Task in another project' },
    ]);
    taskId = ownedTask._id.toString();
    taskInOtherProjectId = taskInOtherProject._id.toString();
  });

  async function removeTask(path: string, authenticated = true) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'DELETE',
      headers: authenticated ? { Authorization: 'Bearer test-owner' } : {},
    });
    return { status: response.status, body: await response.json() };
  }

  it('deletes an owned task and returns its ID', async () => {
    const response = await removeTask(`/${projectId}/tasks/${taskId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      deletedId: taskId,
      message: 'Task deleted successfully',
    });
    expect(await ProjectTask.findById(taskId)).toBeNull();
  });

  it('does not delete a task from another user project', async () => {
    const foreignTask = await ProjectTask.create({ projectId: foreignProjectId, title: 'Foreign task' });
    const response = await removeTask(`/${foreignProjectId}/tasks/${foreignTask.id}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(await ProjectTask.findById(foreignTask.id)).not.toBeNull();
  });

  it('does not delete a task that belongs to a different project owned by the same user', async () => {
    const response = await removeTask(`/${projectId}/tasks/${taskInOtherProjectId}`);

    expect(response.status).toBe(404);
    expect(await ProjectTask.findById(taskInOtherProjectId)).not.toBeNull();
  });

  it('returns 404 for a task that does not exist', async () => {
    const missingTaskId = new Types.ObjectId().toString();
    const response = await removeTask(`/${projectId}/tasks/${missingTaskId}`);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });

  it('returns 404 when the project does not belong to the authenticated user', async () => {
    const response = await removeTask(`/${foreignProjectId}/tasks/${taskId}`);

    expect(response.status).toBe(404);
    expect(await ProjectTask.findById(taskId)).not.toBeNull();
  });

  it.each([
    '/invalid-id/tasks/000000000000000000000001',
    '/000000000000000000000001/tasks/invalid-id',
  ])('rejects malformed project or task IDs with a validation error: %s', async path => {
    const response = await removeTask(path);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(await ProjectTask.findById(taskId)).not.toBeNull();
  });

  it('requires authentication', async () => {
    const response = await removeTask(`/${projectId}/tasks/${taskId}`, false);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ success: false, code: 'UNAUTHORIZED' });
    expect(await ProjectTask.findById(taskId)).not.toBeNull();
  });
});
