import { env } from '../../config/env.js';

interface GitHubRepository {
  owner: string;
  name: string;
}

export interface GitHubProjectMetrics {
  stars: number;
  forks: number;
  language: string;
  totalCommits: number;
  totalPullRequests: number;
  totalIssues: number;
  openIssues: number;
  lastCommitAt: Date | null;
  lastCommitMessage: string | null;
}

export function parseGitHubRepositoryUrl(value: string | null): GitHubRepository | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || !/^[A-Za-z0-9-]{1,39}$/.test(parts[0])) return null;
    const name = parts[1].replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return null;
    return { owner: parts[0], name };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid GitHub count');
  }
  return value;
}

async function request(path: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return fetch(`https://api.github.com${path}`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
}

async function listCount(path: string, allowEmptyRepository = false): Promise<{ total: number; first: unknown }> {
  const response = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=1`);
  if (allowEmptyRepository && response.status === 409) return { total: 0, first: null };
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  const items: unknown = await response.json();
  if (!Array.isArray(items)) throw new Error('Invalid GitHub list response');

  // A one-item page makes GitHub's last-page number the collection count.
  // Never follow a Link URL supplied by the remote response.
  const link = response.headers.get('link');
  const last = link?.split(',').find(part => /rel="last"/.test(part));
  if (last) {
    const page = /[?&]page=(\d+)/.exec(last)?.[1];
    if (!page) throw new Error('Invalid GitHub pagination');
    return { total: count(Number(page)), first: items[0] ?? null };
  }
  if (link?.includes('rel="next"')) throw new Error('GitHub did not provide a final page');
  return { total: items.length, first: items[0] ?? null };
}

export async function fetchGitHubProjectMetrics(repository: GitHubRepository): Promise<GitHubProjectMetrics> {
  const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const response = await request(base);
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  const data: unknown = await response.json();
  if (!isRecord(data) || data.private !== false || typeof data.default_branch !== 'string') {
    throw new Error('Unsupported or invalid GitHub repository');
  }
  const stars = count(data.stargazers_count);
  const forks = count(data.forks_count);
  if (data.language !== null && typeof data.language !== 'string') throw new Error('Invalid GitHub language');

  const [commits, pulls, openPulls, issues, openIssues] = await Promise.all([
    listCount(`${base}/commits?sha=${encodeURIComponent(data.default_branch)}`, true),
    listCount(`${base}/pulls?state=all`),
    listCount(`${base}/pulls?state=open`),
    listCount(`${base}/issues?state=all`),
    listCount(`${base}/issues?state=open`),
  ]);

  // GitHub's issue list includes pull requests in both states.
  if (issues.total < pulls.total || openIssues.total < openPulls.total) {
    throw new Error('Inconsistent GitHub issue counts');
  }
  let lastCommitAt: Date | null = null;
  let lastCommitMessage: string | null = null;
  if (commits.total > 0) {
    const commit = isRecord(commits.first) ? commits.first.commit : null;
    const committer = isRecord(commit) ? commit.committer : null;
    const date = isRecord(committer) ? committer.date : null;
    if (typeof date !== 'string' || !isRecord(commit) || typeof commit.message !== 'string') {
      throw new Error('Invalid GitHub commit');
    }
    lastCommitAt = new Date(date);
    if (Number.isNaN(lastCommitAt.getTime())) throw new Error('Invalid GitHub commit date');
    lastCommitMessage = commit.message;
  }

  return {
    stars,
    forks,
    language: data.language ?? '',
    totalCommits: commits.total,
    totalPullRequests: pulls.total,
    totalIssues: issues.total - pulls.total,
    openIssues: openIssues.total - openPulls.total,
    lastCommitAt,
    lastCommitMessage,
  };
}

export async function fetchGitHubRepositoryEvidence(repository: GitHubRepository, contributor?: {
  id: string;
  username: string;
}) {
  const base = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  const json = async (path: string): Promise<unknown> => {
    const response = await request(path);
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    return response.json();
  };
  const response = await request(base);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  const data: unknown = await response.json();
  if (isRecord(data) && data.private === true) return null;
  if (!isRecord(data) || data.private !== false || typeof data.default_branch !== 'string'
      || typeof data.full_name !== 'string' || !parseGitHubRepositoryUrl(`https://github.com/${data.full_name}`)
      || typeof data.name !== 'string' || typeof data.created_at !== 'string'
      || typeof data.fork !== 'boolean' || typeof data.archived !== 'boolean') {
    throw new Error('Unsupported or invalid GitHub repository');
  }
  const createdAt = Date.parse(data.created_at);
  if (!Number.isFinite(createdAt)) throw new Error('Invalid GitHub repository creation date');
  const branch = encodeURIComponent(data.default_branch);
  const [commits, contributions, languages, tree] = await Promise.all([
    listCount(`${base}/commits?sha=${branch}`, true),
    contributor
      ? listCount(`${base}/commits?sha=${branch}&author=${encodeURIComponent(contributor.username)}`, true)
      : null,
    json(`${base}/languages`),
    count(data.size) ? json(`${base}/git/trees/${branch}?recursive=1`) : null,
  ]);
  const first = contributions?.first;
  const matchedContributor = Boolean(contributor && isRecord(data.owner)
    && String(data.owner.id) === contributor.id && isRecord(first) && isRecord(first.author)
    && String(first.author.id) === contributor.id);
  const commit = isRecord(commits.first) ? commits.first.commit : null;
  const lastCommitAt = isRecord(commit) && isRecord(commit.committer)
    && typeof commit.committer.date === 'string' ? new Date(commit.committer.date) : null;
  const paths = isRecord(tree) && Array.isArray(tree.tree)
    ? tree.tree.flatMap(entry => isRecord(entry) && entry.type === 'blob' && typeof entry.path === 'string'
      ? [entry.path] : [])
    : [];
  const languageBytes = isRecord(languages)
    ? Object.fromEntries(Object.entries(languages).map(([name, bytes]) => [name, count(bytes)]))
    : {};
  return {
    githubRepoId: String(count(data.id)),
    repoFullName: data.full_name,
    repoUrl: `https://github.com/${data.full_name}`,
    name: data.name,
    description: typeof data.description === 'string' ? data.description : null,
    isFork: data.fork,
    isArchived: data.archived,
    repoAgeInDays: Math.max(0, Math.floor((Date.now() - createdAt) / 86_400_000)),
    primaryLanguage: typeof data.language === 'string' ? data.language : '',
    languages: languageBytes,
    stars: count(data.stargazers_count),
    forks: count(data.forks_count),
    totalCommitCount: commits.total,
    userCommitCount: matchedContributor ? contributions?.total ?? 0 : 0,
    contributorId: matchedContributor ? contributor?.id : undefined,
    lastCommitAt: lastCommitAt && Number.isFinite(lastCommitAt.getTime()) ? lastCommitAt : null,
    fileCount: paths.length,
    files: paths.filter(path => /(^|\/)(dockerfile|docker-compose|readme|\.github\/workflows\/|\.gitlab-ci)/i.test(path)).slice(0, 100),
    hasTests: paths.some(path => /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$/i.test(path)),
    hasCI: paths.some(path => /^\.github\/workflows\/.+\.ya?ml$|^\.gitlab-ci\.yml$/i.test(path)),
  };
}
