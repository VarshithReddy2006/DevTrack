import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { PlatformStats } from '../../../db/models/platformStats.model.js';
import { Project } from '../../../db/models/project.model.js';
import { User } from '../../../db/models/user.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { VerifiedProjectIngestionService } from '../../../modules/readiness/services/VerifiedProjectIngestionService.js';

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@clerk/express', () => ({ clerkClient: { users: { getUser } } }));

const repoUrl = 'https://github.com/example/project';

function mockRepository() {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/commits')) {
      return Response.json([{ author: { id: 7 }, commit: { committer: { date: '2026-10-01T12:00:00Z' } } }]);
    }
    if (url.pathname.endsWith('/languages')) return Response.json({ TypeScript: 1000 });
    if (url.pathname.endsWith('/git/trees/main')) {
      return Response.json({ tree: [{ path: 'test/example.test.ts', type: 'blob' }] });
    }
    return Response.json({
      id: 42, name: 'project', full_name: 'Example/Project', private: false, default_branch: 'main',
      created_at: '2025-01-01T00:00:00Z', size: 12, language: 'TypeScript', owner: { id: 7 },
      fork: false, archived: false, stargazers_count: 3, forks_count: 0,
    });
  }));
}

describe('verified project ingestion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    getUser.mockReset();
  });

  it('deduplicates concurrent links and synced copies by the provider repository ID', async () => {
    await VerifiedProject.init();
    const userId = new Types.ObjectId();
    await User.create({ _id: userId, clerkId: 'clerk_example', email: 'test@example.test', username: 'example', displayName: 'Example' });
    await PlatformStats.create({
      userId, platformName: 'github', username: 'example', rawData: { repository_urls: [repoUrl] },
    });
    const project = await Project.create({ userId, name: 'Example', repoUrl: 'https://github.com/Example/Project.git' });
    getUser.mockResolvedValue({ externalAccounts: [{
      provider: 'github', providerUserId: '7', username: 'Example', verification: { status: 'verified' },
    }] });
    mockRepository();

    await Promise.all([
      VerifiedProjectIngestionService.ingest(userId.toString(), project._id),
      VerifiedProjectIngestionService.ingest(userId.toString()),
    ]);
    await VerifiedProjectIngestionService.ingest(userId.toString(), project._id);
    expect(await VerifiedProject.countDocuments({ userId })).toBe(1);
    expect(await VerifiedProject.findOne({ userId }).lean()).toMatchObject({
      githubRepoId: '42', projectId: project._id, repoFullName: 'example/project',
      verification: { status: 'verified', verifiedAt: expect.any(Date) },
      metrics: { userCommitCount: 1, totalCommitCount: 1 },
      provenance: { contributorId: '7', hasTests: true, discoveredBySync: true },
    });
  });

  it('preserves an existing manually reviewed record', async () => {
    await VerifiedProject.init();
    const userId = new Types.ObjectId();
    const project = await Project.create({ userId, name: 'Example', repoUrl });
    await VerifiedProject.create({
      userId, githubRepoId: '42', repoFullName: 'example/project', repoUrl, name: 'Reviewed',
      verification: { status: 'rejected' },
    });
    mockRepository();

    await VerifiedProjectIngestionService.ingest(userId.toString(), project._id);
    expect(await VerifiedProject.countDocuments({ userId })).toBe(1);
    expect(await VerifiedProject.findOne({ userId }).lean()).toMatchObject({
      name: 'Reviewed', verification: { status: 'rejected' },
    });
  });
});
