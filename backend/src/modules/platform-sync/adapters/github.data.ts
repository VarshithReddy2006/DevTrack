import { logger } from '../../../shared/logger.js';
import { fetchWithRetry } from './http.js';
import type { FetchedPlatformStats } from './types.js';
import { env } from '../../../config/env.js';

export async function fetchStatsData(username: string): Promise<FetchedPlatformStats> {
  // Build headers - use Bearer token if available, otherwise anonymous
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Add authentication if token is available
  const githubToken = env.GITHUB_TOKEN;
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
    logger.info('Using authenticated GitHub API requests');
  } else {
    logger.warn('No GitHub token configured - using anonymous requests (rate limited)');
  }

  // Fetch user profile
  const userRes = await fetchWithRetry(
    `https://api.github.com/users/${encodeURIComponent(username)}`,
    { headers }
  );

  if (!userRes.ok) {
    if (userRes.status === 404) {
      logger.error('GitHub user not found', { username });
      throw new Error('GitHub user not found');
    }
    if (userRes.status === 403) {
      logger.error('GitHub API rate limit exceeded', { username });
      throw new Error('GitHub API rate limit exceeded - consider adding GITHUB_TOKEN');
    }
    const errorText = await userRes.text().catch(() => 'No response body');
    logger.error(`GitHub API error (${userRes.status})`, { username, errorText: errorText.slice(0, 200) });
    throw new Error(`GitHub API error (${userRes.status})`);
  }

  const data = await userRes.json() as Record<string, unknown>;

  const publicRepos = (data.public_repos as number) ?? 0;
  const followers = (data.followers as number) ?? 0;
  const following = (data.following as number) ?? 0;

  // Lightweight enrichment: fetch repos to get totalStars and topLanguages
  let totalStars = 0;
  const repositoryUrls: string[] = [];
  const languageCounts: Record<string, number> = {};

  try {
    const reposRes = await fetchWithRetry(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`,
      { headers }
    );

    if (reposRes.ok) {
      const repos = await reposRes.json() as Array<Record<string, unknown>>;

      for (const repo of repos) {
        if (repo.private === false && typeof repo.html_url === 'string') repositoryUrls.push(repo.html_url);
        const stars = (repo.stargazers_count as number) ?? 0;
        totalStars += stars;

        const language = (repo.language as string) ?? null;
        if (language) {
          languageCounts[language] = (languageCounts[language] ?? 0) + 1;
        }
      }

      logger.info('GitHub repos enrichment completed', {
        username,
        reposCount: repos.length,
        totalStars,
        languages: Object.keys(languageCounts).length,
      });
    } else if (reposRes.status === 403) {
      logger.warn('GitHub repos API rate limited - skipping enrichment', { username });
    }
  } catch (err) {
    logger.warn('GitHub repos enrichment failed (non-fatal)', {
      username,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Get top 5 languages
  const topLanguages = Object.entries(languageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);

  return {
    username,
    totalSolved: publicRepos, // Map repos as the primary metric for GitHub
    easySolved: 0,
    mediumSolved: 0,
    hardSolved: 0,
    rating: null,
    rank: null,
    totalContests: 0,
    rawData: {
      public_repos: publicRepos,
      followers,
      following,
      total_stars: totalStars,
      top_languages: topLanguages,
      repository_urls: repositoryUrls,
      name: data.name ?? null,
      bio: data.bio ?? null,
      avatar_url: data.avatar_url ?? null,
      html_url: data.html_url ?? null,
      created_at: data.created_at ?? null,
      synced_at: new Date().toISOString(),
    },
  };
}
