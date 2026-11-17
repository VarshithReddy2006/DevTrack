import { expect, it, vi } from 'vitest';
import { RepositoryIntelligenceEngine } from './RepositoryIntelligenceEngine.js';

vi.mock('../../../config/env.js', () => ({ env: { GITHUB_TOKEN: 'fixture-token' } }));

const metadata = {
  private: false, default_branch: 'release/main', full_name: 'Example/Project', language: 'TypeScript',
};

function tree(paths: string[], truncated = false) {
  return Response.json({
    sha: 'fixture-tree-sha',
    truncated,
    tree: [
      ...paths.map(path => ({ path, type: 'blob' })),
      { path: 'other/Dockerfile', type: 'tree' },
    ],
  });
}

it('reports different signals for different public GitHub file trees', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(tree([
      'backend/Dockerfile', 'k8s/deploy.yaml', '.github/workflows/build.yml', '.github/workflows/README.md',
      'vercel.json', 'src/controllers/index.ts', 'src/models/index.ts', 'src/health.test.ts',
    ]))
    .mockResolvedValueOnce(Response.json({ ...metadata, full_name: 'Example/Script' }))
    .mockResolvedValueOnce(tree(['hello.ts']));
  const engine = new RepositoryIntelligenceEngine(fetcher);

  await expect(engine.analyzeRepository('https://github.com/Example/Project.git')).resolves.toMatchObject({
    status: 'complete',
    repository: 'Example/Project',
    language: 'TypeScript',
    defaultBranch: 'release/main',
    treeSha: 'fixture-tree-sha',
    infra: { hasDocker: true, hasKubernetes: true },
    architecture: { patterns: ['Controllers', 'Models'], hasTests: true },
    cicd: { workflowCount: 1, platform: 'GitHub Actions' },
    deployment: { evidenceFound: true, platform: 'Vercel' },
    complexity: { fileCount: 8, maxDirectoryDepth: 2 },
  });
  await expect(engine.analyzeRepository('https://github.com/Example/Script')).resolves.toMatchObject({
    status: 'complete',
    infra: { hasDocker: false, hasKubernetes: false },
    architecture: { patterns: [], hasTests: false },
    cicd: { workflowCount: 0, platform: null },
    deployment: { evidenceFound: false, platform: null },
    complexity: { fileCount: 1, maxDirectoryDepth: 0 },
  });
  expect(fetcher).toHaveBeenNthCalledWith(2,
    'https://api.github.com/repos/Example/Project/git/trees/release%2Fmain?recursive=1',
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fixture-token' }), redirect: 'error' }),
  );
});

it('validates repository URLs and handles missing or private repositories before fetching their trees', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json({ ...metadata, private: true }));
  const engine = new RepositoryIntelligenceEngine(fetcher);

  await expect(engine.analyzeRepository('https://other.example/Example/Project')).resolves.toEqual({
    status: 'unavailable', reason: 'invalid-url',
  });
  expect(fetcher).not.toHaveBeenCalled();
  for (const url of ['https://github.com/Example/Missing', 'https://github.com/Example/Private']) {
    await expect(engine.analyzeRepository(url)).resolves.toEqual({
      status: 'unavailable', reason: 'repository-unavailable',
    });
  }
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([403, 429])('surfaces GitHub rate limit status %s as a worker failure', async status => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
    status, headers: { 'x-ratelimit-remaining': '0' },
  }));
  await expect(new RepositoryIntelligenceEngine(fetcher).analyzeRepository('https://github.com/Example/Project'))
    .rejects.toThrow('GitHub API rate limit exceeded');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('distinguishes truncated, missing and empty trees', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(tree(['Dockerfile'], true))
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(Response.json(metadata))
    .mockResolvedValueOnce(new Response(null, { status: 409 }));
  const engine = new RepositoryIntelligenceEngine(fetcher);
  const url = 'https://github.com/Example/Project';

  await expect(engine.analyzeRepository(url)).resolves.toMatchObject({
    status: 'partial', infra: { hasDocker: true },
  });
  await expect(engine.analyzeRepository(url)).resolves.toEqual({
    status: 'unavailable', reason: 'tree-unavailable',
  });
  await expect(engine.analyzeRepository(url)).resolves.toMatchObject({
    status: 'complete', treeSha: null, complexity: { fileCount: 0 },
  });
});
