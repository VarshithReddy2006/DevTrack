import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ActivityEvent, DsaProblem, Project } from '../db/models/index.js';
import { errorHandler } from '../middleware/error.js';
import dsaRoutes from '../modules/dsa/dsa.routes.js';
import projectRoutes from '../modules/projects/projects.routes.js';
import activityRoutes from '../modules/activity/activity.routes.js';

// Route params must be rejected before they reach ObjectId construction.
// Keep the real validators, controllers, services and disposable MongoDB;
// replace only external Clerk authentication with a fixed test identity.
vi.mock('../middleware/index.js', async () => {
  const { validateBody } = await import('../middleware/validation.js');
  const { asyncHandler } = await import('../middleware/error.js');
  const { commonErrors } = await import('../shared/response.js');
  return {
    validateBody,
    asyncHandler,
    authMiddleware: [(req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.get('authorization') !== 'Bearer test-owner') { commonErrors.unauthorized(res); return; }
      Object.assign(req, { user: { id: '000000000000000000000001' } }); next();
    }],
  };
});

const malformedId = 'not-an-object-id';

const malformedCases: Array<{ method: string; route: string; body?: unknown }> = [
  { method: 'GET', route: `/api/v1/dsa/problems/${malformedId}` },
  { method: 'PATCH', route: `/api/v1/dsa/problems/${malformedId}`, body: {} },
  { method: 'DELETE', route: `/api/v1/dsa/problems/${malformedId}` },
  { method: 'POST', route: `/api/v1/dsa/problems/${malformedId}/favorite` },
  { method: 'GET', route: `/api/v1/projects/${malformedId}` },
  { method: 'PATCH', route: `/api/v1/projects/${malformedId}`, body: {} },
  { method: 'DELETE', route: `/api/v1/projects/${malformedId}` },
  { method: 'GET', route: `/api/v1/projects/${malformedId}/tasks` },
  { method: 'POST', route: `/api/v1/projects/${malformedId}/tasks`, body: { title: 't', description: 'd', status: 'todo', priority: 'low' } },
  { method: 'PATCH', route: `/api/v1/projects/${malformedId}/tasks/${malformedId}`, body: {} },
  { method: 'DELETE', route: `/api/v1/activity/${malformedId}` },
];

describe('ObjectId route params', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await Promise.all([DsaProblem.init(), Project.init(), ActivityEvent.init()]);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/dsa', dsaRoutes);
    app.use('/api/v1/projects', projectRoutes);
    app.use('/api/v1/activity', activityRoutes);
    app.use(errorHandler);
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  async function request(method: string, route: string, body?: unknown) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-owner' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }

  it.each(malformedCases)('returns 400 for malformed id on $method $route', async ({ method, route, body }) => {
    const response = await request(method, route, body);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('preserves 404 for a well-formed but nonexistent dsa problem id', async () => {
    const response = await request('GET', `/api/v1/dsa/problems/${new Types.ObjectId().toHexString()}`);
    expect(response.status).toBe(404);
  });

  it('preserves 404 for a well-formed but nonexistent project id', async () => {
    const response = await request('GET', `/api/v1/projects/${new Types.ObjectId().toHexString()}`);
    expect(response.status).toBe(404);
  });

  it('preserves 404 for a well-formed but nonexistent activity id', async () => {
    const response = await request('DELETE', `/api/v1/activity/${new Types.ObjectId().toHexString()}`);
    expect(response.status).toBe(404);
  });
});
