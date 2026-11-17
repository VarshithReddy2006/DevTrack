import { z } from 'zod';
import { parseGitHubRepositoryUrl, requestGitHub } from '../../projects/project-github-sync.js';

const repositorySchema = z.object({
  private: z.boolean(),
  default_branch: z.string().min(1),
  full_name: z.string().min(1),
  language: z.string().nullable(),
});

const treeSchema = z.object({
  sha: z.string().min(1),
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string().min(1), type: z.string() })),
});

async function readGitHubResponse(response: Response): Promise<unknown> {
  if (response.status === 429 || (response.status === 403
      && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
    throw new Error('GitHub API rate limit exceeded');
  }
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  return response.json();
}

function analyzePaths(paths: string[]) {
  const architecture = [
    ['Controllers', /(^|\/)controllers?\//i],
    ['Models', /(^|\/)models?\//i],
    ['Views', /(^|\/)views?\//i],
    ['Routes', /(^|\/)routes?\//i],
    ['Services', /(^|\/)services?\//i],
  ] as const;
  const deployments = [
    ['Vercel', /(^|\/)vercel\.json$/i],
    ['Netlify', /(^|\/)netlify\.toml$/i],
    ['Render', /(^|\/)render\.ya?ml$/i],
    ['Fly.io', /(^|\/)fly\.toml$/i],
  ] as const;
  const platforms = deployments.filter(([, pattern]) => paths.some(path => pattern.test(path)))
    .map(([name]) => name);
  const workflowCount = paths.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)).length;

  return {
    infra: {
      hasDocker: paths.some(path => /(^|\/)(Dockerfile(?:\.[^/]+)?|(?:docker-)?compose(?:\.[^/]+)?\.ya?ml)$/i.test(path)),
      hasKubernetes: paths.some(path => /(^|\/)(k8s|kubernetes)\/.+\.ya?ml$|(^|\/)(Chart\.yaml|kustomization\.ya?ml)$/i.test(path)),
    },
    architecture: {
      patterns: architecture.filter(([, pattern]) => paths.some(path => pattern.test(path)))
        .map(([name]) => name),
      hasTests: paths.some(path => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/i.test(path)),
    },
    deployment: { evidenceFound: platforms.length > 0, platform: platforms[0] ?? null, platforms },
    cicd: { workflowCount, platform: workflowCount ? 'GitHub Actions' : null },
    complexity: {
      fileCount: paths.length,
      maxDirectoryDepth: paths.reduce((max, path) => Math.max(max, path.split('/').length - 1), 0),
    },
  };
}

export class RepositoryIntelligenceEngine {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async analyzeRepository(repoUrl: string) {
    const repository = parseGitHubRepositoryUrl(repoUrl);
    if (!repository) return { status: 'unavailable', reason: 'invalid-url' } as const;

    const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const response = await requestGitHub(base, this.fetcher);
    if (response.status === 404) return { status: 'unavailable', reason: 'repository-unavailable' } as const;

    const data = repositorySchema.parse(await readGitHubResponse(response));
    if (data.private) return { status: 'unavailable', reason: 'repository-unavailable' } as const;

    const treeResponse = await requestGitHub(
      `${base}/git/trees/${encodeURIComponent(data.default_branch)}?recursive=1`,
      this.fetcher,
    );
    if (treeResponse.status === 404) return { status: 'unavailable', reason: 'tree-unavailable' } as const;

    // GitHub returns 409 for the tree of an empty repository.
    const tree = treeResponse.status === 409 ? null : treeSchema.parse(await readGitHubResponse(treeResponse));
    const paths = tree?.tree.filter(entry => entry.type === 'blob').map(entry => entry.path) ?? [];

    return {
      status: tree?.truncated ? 'partial' as const : 'complete' as const,
      repository: data.full_name,
      language: data.language,
      defaultBranch: data.default_branch,
      treeSha: tree?.sha ?? null,
      ...analyzePaths(paths),
    };
  }
}
