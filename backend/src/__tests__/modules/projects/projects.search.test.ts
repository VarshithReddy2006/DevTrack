import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityEvent, Project } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import projectsRoutes from '../../../modules/projects/projects.routes.js';
import { getProjectStats, getProjects } from '../../../modules/projects/projects.service.js';

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

const ownerId = new Types.ObjectId('000000000000000000000001');
const otherUserId = new Types.ObjectId('000000000000000000000002');

describe('GET /projects search', () => {
  let server: Server;
  let baseUrl: string;

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
      server.close(error => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(async () => {
    await Project.create([
      { userId: ownerId, name: 'C++ compiler', description: 'toy compiler' },
      { userId: ownerId, name: 'Gateway', description: 'node (api) gateway' },
      { userId: ownerId, name: 'Notes [wip]', description: 'draft' },
      { userId: ownerId, name: 'Plain project', description: 'nothing special' },
      { userId: ownerId, name: 'Regex chars', description: 'uses .*+?^${}()|[]\\ literally' },
      { userId: otherUserId, name: 'C++ foreign', description: 'other user' },
    ]);
  });

  async function search(value: string) {
    const response = await fetch(`${baseUrl}?search=${encodeURIComponent(value)}`, {
      headers: { Authorization: 'Bearer test-owner' },
    });
    return { status: response.status, body: await response.json() };
  }

  function names(body: { data: { projects: Array<{ name: string }> } }) {
    return body.data.projects.map(project => project.name).sort();
  }

  it('matches c++ as a literal substring', async () => {
    const { status, body } = await search('c++');
    expect(status).toBe(200);
    expect(names(body)).toEqual(['C++ compiler']);
    expect(body.data.pagination.totalItems).toBe(1);
  });

  it('matches "node (api)" in the description', async () => {
    const { status, body } = await search('node (api)');
    expect(status).toBe(200);
    expect(names(body)).toEqual(['Gateway']);
  });

  it.each(['[wip]', '(backend', '[', ')', '\\', '*', '?'])('does not 500 on %s', async (value) => {
    const { status } = await search(value);
    expect(status).toBe(200);
  });

  it('treats metacharacters literally instead of as a pattern', async () => {
    const { status, body } = await search('.*');
    expect(status).toBe(200);
    expect(names(body)).toEqual(['Regex chars']);
  });

  it('matches the full metacharacter string literally', async () => {
    const { status, body } = await search('.*+?^${}()|[]\\');
    expect(status).toBe(200);
    expect(names(body)).toEqual(['Regex chars']);
  });

  it('trims the search term', async () => {
    const { status, body } = await search('  c++  ');
    expect(status).toBe(200);
    expect(names(body)).toEqual(['C++ compiler']);
  });

  it('answers quickly for a long pathological pattern at the length limit', async () => {
    const started = Date.now();
    const { status, body } = await search(`${'(a+)+'.repeat(20)}$`.slice(0, 100));
    expect(status).toBe(200);
    expect(body.data.projects).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects a search term longer than 100 characters with 400', async () => {
    const { status } = await search('a'.repeat(101));
    expect(status).toBe(400);
  });

  it('rejects a repeated search parameter with 400 instead of 500', async () => {
    const response = await fetch(`${baseUrl}?search=a&search=b`, {
      headers: { Authorization: 'Bearer test-owner' },
    });
    expect(response.status).toBe(400);
  });

  it('still paginates a search', async () => {
    await Project.create([
      { userId: ownerId, name: 'Gateway two', description: 'second' },
      { userId: ownerId, name: 'Gateway three', description: 'third' },
    ]);
    const response = await fetch(`${baseUrl}?search=gateway&pageSize=2&page=2`, {
      headers: { Authorization: 'Bearer test-owner' },
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.projects).toHaveLength(1);
    expect(body.data.pagination.page).toBe(2);
  });
});

describe('getProjectStats aggregation', () => {
  beforeEach(async () => {
    await Project.create([
      { userId: ownerId, name: 'a', status: 'in_progress', language: 'TypeScript', totalCommits: 10, totalPullRequests: 2, totalIssues: 1 },
      { userId: ownerId, name: 'b', status: 'in_progress', language: 'TypeScript', totalCommits: 5, totalPullRequests: 1, totalIssues: 0 },
      { userId: ownerId, name: 'c', status: 'completed', language: 'Go', totalCommits: 7, totalPullRequests: 3, totalIssues: 4 },
      { userId: ownerId, name: 'd', status: 'planning', language: '', totalCommits: 0, totalPullRequests: 0, totalIssues: 0 },
      { userId: ownerId, name: 'e', status: 'archived', totalCommits: 1, totalPullRequests: 1, totalIssues: 1 },
      { userId: otherUserId, name: 'foreign', status: 'completed', language: 'Rust', totalCommits: 99, totalPullRequests: 99, totalIssues: 99 },
    ]);
  });

  it('matches totals computed in JS from the same documents', async () => {
    const docs = await Project.find({ userId: ownerId }).lean();
    const expectedLanguages: Record<string, number> = {};
    for (const doc of docs) {
      if (doc.language) expectedLanguages[doc.language] = (expectedLanguages[doc.language] || 0) + 1;
    }

    const stats = await getProjectStats(ownerId.toHexString());

    expect(stats).toEqual({
      totalProjects: docs.length,
      activeProjects: docs.filter(doc => doc.status === 'in_progress').length,
      completedProjects: docs.filter(doc => doc.status === 'completed').length,
      totalCommits: docs.reduce((sum, doc) => sum + (doc.totalCommits || 0), 0),
      totalPullRequests: docs.reduce((sum, doc) => sum + (doc.totalPullRequests || 0), 0),
      totalIssues: docs.reduce((sum, doc) => sum + (doc.totalIssues || 0), 0),
      languageDistribution: expectedLanguages,
      commitHistory: [],
    });
    expect(stats.languageDistribution).toEqual({ TypeScript: 2, Go: 1 });
    expect(stats.totalProjects).toBe(5);
  });

  it('returns zeroed stats when the user has no projects', async () => {
    const stats = await getProjectStats(new Types.ObjectId().toHexString());
    expect(stats).toEqual({
      totalProjects: 0,
      activeProjects: 0,
      completedProjects: 0,
      totalCommits: 0,
      totalPullRequests: 0,
      totalIssues: 0,
      languageDistribution: {},
      commitHistory: [],
    });
  });

  it('includes commit history and stays independent of the search filter in getProjects', async () => {
    // The stats query matches type 'commit', which the model enum does not list, so insert directly.
    await ActivityEvent.collection.insertOne({
      userId: ownerId,
      type: 'commit',
      platform: 'github',
      title: 'commit',
      occurredAt: new Date(),
    });
    const all = await getProjectStats(ownerId.toHexString());
    const filtered = await getProjects(ownerId.toHexString(), { search: 'c++' });

    expect(filtered.projects).toEqual([]);
    expect(filtered.pagination.totalItems).toBe(0);
    expect(filtered.stats).toEqual(all);
    expect(all.commitHistory).toHaveLength(1);
  });
});
