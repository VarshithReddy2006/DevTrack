import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Project } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import projectsRoutes from '../../../modules/projects/projects.routes.js';

vi.mock('../../../middleware/index.js', async () => {
  const { validateBody, validateParams } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    validateBody, validateParams, asyncHandler,
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
const otherId = new Types.ObjectId('000000000000000000000002');
const repositoryUrl = 'https://github.com/example/project';

describe('Project GitHub sync route', () => {
  let server: Server;
  let baseUrl: string;
  let projectId: string;
  let foreignProjectId: string;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectsRoutes);
    app.use(errorHandler);
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  beforeEach(async () => {
    const [owned, foreign] = await Project.create([
      { userId: ownerId, name: 'Owned', repoUrl: repositoryUrl },
      { userId: otherId, name: 'Foreign', repoUrl: repositoryUrl },
    ]);
    projectId = owned.id;
    foreignProjectId = foreign.id;
  });

  afterEach(() => vi.restoreAllMocks());

  function mockGithub(options: {
    failPath?: string;
    privateRepository?: boolean;
    emptyRepository?: boolean;
    onRequest?: (url: URL) => Promise<void>;
  } = {}) {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
      calls.push(url);
      const parsed = new URL(url);
      if (options.onRequest) await options.onRequest(parsed);
      if (options.failPath && parsed.pathname.endsWith(options.failPath)) return Response.json({ message: 'Unavailable' }, { status: 503 });
      if (parsed.pathname === '/repos/example/project') return Response.json({
        stargazers_count: 7, forks_count: 3, language: 'TypeScript',
        open_issues_count: 4, default_branch: 'main', private: options.privateRepository ?? false,
      });
      if (options.emptyRepository && parsed.pathname.endsWith('/commits')) {
        return Response.json({ message: 'Git Repository is empty.' }, { status: 409 });
      }
      const lastPage = parsed.pathname.endsWith('/commits') ? 11
        : parsed.pathname.endsWith('/pulls') ? (parsed.searchParams.get('state') === 'open' ? 1 : 5)
        : parsed.pathname.endsWith('/issues') ? (parsed.searchParams.get('state') === 'open' ? 4 : 9) : null;
      if (lastPage === null) throw new Error(`Unexpected GitHub endpoint: ${url}`);
      const headers = new Headers();
      if (lastPage > 1) headers.set('Link', `<https://api.github.com${parsed.pathname}?per_page=1&page=${lastPage}>; rel="last"`);
      return Response.json(parsed.pathname.endsWith('/commits')
        ? [{ commit: { committer: { date: '2026-10-01T12:00:00Z' }, message: 'Latest commit' } }]
        : [{}], { headers });
    });
    return calls;
  }

  async function sync(id = projectId, authenticated = true) {
    const response = await realFetch(`${baseUrl}/${id}/sync`, {
      method: 'POST',
      headers: authenticated ? { Authorization: 'Bearer test-owner' } : {},
    });
    return { status: response.status, body: await response.json() };
  }

  it('refreshes GitHub metrics before reporting success', async () => {
    const calls = mockGithub();
    const result = await sync();
    const project = await Project.findById(projectId);

    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    expect(calls).toHaveLength(6);
    expect(calls.every(url => url.startsWith('https://api.github.com/repos/example/project'))).toBe(true);
    expect(project).toMatchObject({ stars: 7, forks: 3, language: 'TypeScript', totalCommits: 11,
      totalPullRequests: 5, totalIssues: 4, openIssues: 3, lastCommitMessage: 'Latest commit' });
    expect(project?.lastCommitAt?.toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });

  it.each([null, 'https://evil.example/example/project', 'https://github.com.evil.example/example/project',
    'https://github.com/example/project/issues'])
  ('rejects missing or unsupported repository URL: %s', async repoUrl => {
    await Project.updateOne({ _id: projectId }, { repoUrl });
    const calls = mockGithub();
    const result = await sync();
    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('does not report success or persist partial metrics after an upstream failure', async () => {
    mockGithub({ failPath: '/pulls' });
    const result = await sync();
    const project = await Project.findById(projectId);
    expect(result.status).toBe(502);
    expect(result.body.success).toBe(false);
    expect(project).toMatchObject({ stars: 0, forks: 0, totalCommits: 0, totalPullRequests: 0, totalIssues: 0 });
  });

  it('does not expose metadata from a private repository accessible to the server token', async () => {
    const calls = mockGithub({ privateRepository: true });
    const result = await sync();
    expect(result.status).toBe(502);
    expect(calls).toHaveLength(1);
    expect((await Project.findById(projectId))?.stars).toBe(0);
  });

  it('handles an empty public repository without inventing a latest commit', async () => {
    mockGithub({ emptyRepository: true });
    const result = await sync();
    const project = await Project.findById(projectId);
    expect(result.status).toBe(200);
    expect(project?.totalCommits).toBe(0);
    expect(project?.lastCommitAt).toBeNull();
    expect(project?.lastCommitMessage).toBeNull();
  });

  it('does not apply fetched metrics if the repository URL changes during sync', async () => {
    let changed = false;
    mockGithub({ onRequest: async url => {
      if (!changed && url.pathname.endsWith('/issues')) {
        changed = true;
        await Project.updateOne({ _id: projectId }, { repoUrl: 'https://github.com/other/repository' });
      }
    } });
    const result = await sync();
    expect(result.status).toBe(409);
    expect((await Project.findById(projectId))?.stars).toBe(0);
  });

  it('does not fetch or update another user’s project', async () => {
    const calls = mockGithub();
    const result = await sync(foreignProjectId);
    expect(result.status).toBe(404);
    expect(calls).toHaveLength(0);
    expect((await Project.findById(foreignProjectId))?.stars).toBe(0);
  });

  it('requires authentication', async () => {
    const calls = mockGithub();
    expect((await sync(projectId, false)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
