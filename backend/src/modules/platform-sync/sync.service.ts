// src/modules/platform-sync/sync.service.ts
import { Types } from 'mongoose';
import { ConnectedPlatform, PlatformStats, SyncJob, DsaSubmission, DsaContest, DsaTopicProgress, DsaProblem, DailyActivity } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { createActivity, incrementDailyActivity } from '../activity/activity.service.js';
import { eventBus } from '../../shared/sse/index.js';
import * as cheerio from 'cheerio';
import { env } from '../../config/env.js';
import { circuitBreakers, CircuitOpenError } from '../../shared/circuit-breaker/circuitBreaker.js';
import { acquireSyncLockWithRetry, releaseSyncLock } from '../../shared/redis/syncLock.service.js';
import { getReadinessDsaQueue } from '../../shared/jobs/queueFactory.js';

const SYNC_TIMEOUT_MS = 15000;

export interface SyncResult {
  platform: string;
  success: boolean;
  stats?: {
    totalSolved: number;
    easySolved: number;
    mediumSolved: number;
    hardSolved: number;
    rating?: number;
    rank?: string;
    totalContests?: number;
  };
  error?: string;
}

interface FetchedPlatformStats {
  username: string;
  totalSolved: number;
  easySolved: number;
  mediumSolved: number;
  hardSolved: number;
  rating: number | null;
  rank: string | null;
  totalContests: number;
  rawData: Record<string, unknown>;
}

const FETCH_TIMEOUT = 15000;

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/**
 * fetchWithRetry — Production-grade fetch wrapper with exponential backoff
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retries = 3,
  backoff = 1000
): Promise<Response> {
  try {
    const res = await fetchWithTimeout(url, options);
    
    // Retry on 5xx errors or 429 (Too Many Requests)
    if ((res.status >= 500 || res.status === 429) && retries > 0) {
      const delay = backoff * (2 ** (3 - retries)) + Math.random() * 100;
      logger.warn(`Sync fetch failed (${res.status}). Retrying in ${Math.round(delay)}ms...`, { url, retriesLeft: retries - 1 });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, backoff);
    }
    
    return res;
  } catch (err) {
    if (retries > 0) {
      const delay = backoff * (2 ** (3 - retries)) + Math.random() * 100;
      logger.warn(`Sync fetch error (${err instanceof Error ? err.message : 'Unknown'}). Retrying...`, { url, retriesLeft: retries - 1 });
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, backoff);
    }
    throw err;
  }
}

async function fetchLeetCodeGraphQL(query: string, variables: Record<string, any>): Promise<any> {
  const res = await fetchWithRetry('https://leetcode.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': 'https://leetcode.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`LeetCode GraphQL error: ${res.status}`);
  }

  return res.json();
}

async function fetchLeetCodeRealStats(username: string): Promise<FetchedPlatformStats> {
  const query = `
    query userProfile($username: String!) {
      matchedUser(username: $username) {
        submitStatsGlobal {
          acSubmissionNum {
            difficulty
            count
          }
        }
        submissionCalendar
      }
      userContestRanking(username: $username) {
        attendedContestsCount
        rating
        globalRanking
        topPercentage
      }
    }
  `;

  const response = await fetchLeetCodeGraphQL(query, { username });
  const data = response.data;

  if (!data.matchedUser) {
    throw new Error('LeetCode user not found');
  }

  const stats = data.matchedUser.submitStatsGlobal.acSubmissionNum;
  const contest = data.userContestRanking || { attendedContestsCount: 0, rating: null };

  const totalSolved = stats.find((s: any) => s.difficulty === 'All')?.count || 0;
  const easySolved = stats.find((s: any) => s.difficulty === 'Easy')?.count || 0;
  const mediumSolved = stats.find((s: any) => s.difficulty === 'Medium')?.count || 0;
  const hardSolved = stats.find((s: any) => s.difficulty === 'Hard')?.count || 0;

  // Parse LeetCode submission calendar (unix-timestamp -> count JSON string)
  // and normalize into Record<YYYY-MM-DD, number> for the rolling heatmap
  const submissionCalendar: Record<string, number> = {};
  try {
    const rawCalendar = data.matchedUser.submissionCalendar;
    if (rawCalendar && typeof rawCalendar === 'string') {
      const parsed = JSON.parse(rawCalendar) as Record<string, number>;
      for (const [ts, count] of Object.entries(parsed)) {
        if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
        const d = new Date(parseInt(ts, 10) * 1000);
        if (Number.isNaN(d.getTime())) continue;
        const dateStr = d.toISOString().split('T')[0];
        submissionCalendar[dateStr] = (submissionCalendar[dateStr] ?? 0) + count;
      }
    }
  } catch (calErr) {
    logger.warn('Failed to parse LeetCode submission calendar', {
      username,
      error: calErr instanceof Error ? calErr.message : String(calErr),
    });
  }

  logger.info('LeetCode submission calendar parsed', {
    username,
    calendarDays: Object.keys(submissionCalendar).length,
  });

  return {
    username,
    totalSolved,
    easySolved,
    mediumSolved,
    hardSolved,
    rating: contest.rating ? Math.round(contest.rating) : null,
    rank: null,
    totalContests: contest.attendedContestsCount || 0,
    rawData: {
      submissionCalendar,
      // Used by frontend profile stats
      userContestRanking: data.userContestRanking ?? null,
    },
  };
}

interface CodeforcesUserInfo {
  handle: string;
  rating?: number;
  maxRating?: number;
  rank?: string;
  maxRank?: string;
  contribution?: number;
  friendOfCount?: number;
  avatar?: string;
  organization?: string;
  registrationTimeSeconds?: number;
}

interface CodeforcesRatingChange {
  contestId: number;
  contestName: string;
  handle: string;
  rank: number;
  ratingUpdateTimeSeconds: number;
  oldRating: number;
  newRating: number;
}

interface CodeforcesProblem {
  contestId?: number;
  index?: string;
  name?: string;
  type?: string;
}

interface CodeforcesSubmissionBackend {
  id: number;
  contestId?: number;
  problem?: CodeforcesProblem;
  verdict?: string;
  language?: string;
  creationTimeSeconds?: number;
}

async function fetchCodeforcesRealStats(username: string): Promise<FetchedPlatformStats> {
  const res = await fetchWithRetry(
    `https://codeforces.com/api/user.info?handles=${encodeURIComponent(username)}`
  );

  if (!res.ok) throw new Error(`Codeforces API error (${res.status})`);

  const json = await res.json() as { status: string; result?: unknown[] };
  if (json.status !== 'OK' || !json.result?.[0]) throw new Error('Codeforces user not found');

  const user = json.result[0] as CodeforcesUserInfo;

  // Fetch rating history
  let totalContests = 0;
  let ratingHistory: CodeforcesRatingChange[] = [];
  try {
    const ratingRes = await fetchWithRetry(
      `https://codeforces.com/api/user.rating?handle=${encodeURIComponent(username)}`
    );
    if (ratingRes.ok) {
      const ratingData = await ratingRes.json() as { status: string; result?: CodeforcesRatingChange[] };
      if (ratingData.status === 'OK' && ratingData.result) {
        totalContests = ratingData.result.length;
        ratingHistory = ratingData.result;
      }
    }
  } catch (err) {
    logger.debug('[sync] Optional codeforces rating fetch failed', { username, error: err instanceof Error ? err.message : String(err) });
  }

  // Count unique solved problems
  const uniqueSolved = await fetchUniqueSolvedProblems(username);

  const rawData: Record<string, unknown> = {
    handle: user.handle,
    maxRating: user.maxRating ?? null,
    maxRank: user.maxRank ?? null,
    contribution: user.contribution ?? null,
    friendOfCount: user.friendOfCount ?? null,
    avatar: user.avatar ?? null,
    organization: user.organization ?? null,
    registrationTimeSeconds: user.registrationTimeSeconds ?? null,
    ratingHistory: ratingHistory.slice(-10),
  };

  return {
    username,
    totalSolved: uniqueSolved,
    easySolved: 0,
    mediumSolved: 0,
    hardSolved: 0,
    rating: (user.rating as number) ?? null,
    rank: (user.rank as string) ?? null,
    totalContests,
    rawData,
  };
}

async function fetchCodeChefRealStats(username: string): Promise<FetchedPlatformStats> {
  const url = `https://www.codechef.com/users/${encodeURIComponent(username)}`;
  logger.info(`CodeChef scraping started for user: ${username}`, { url });

  // Fetch with realistic browser User-Agent
  const res = await fetchWithRetry(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });

  logger.info(`CodeChef scrape response status: ${res.status}`, { url });

  if (!res.ok) {
    if (res.status === 404) {
      logger.error('CodeChef user not found', { username, url });
      throw new Error('CodeChef user not found');
    }
    const errorText = await res.text().catch(() => 'No response body');
    logger.error(`CodeChef scrape error (${res.status})`, { username, url, errorText: errorText.slice(0, 200) });
    throw new Error(`CodeChef scrape error (${res.status})`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // Parse rating - look for .rating-number
  let rating: number | null = null;
  const ratingEl = $('.rating-number').first();
  if (ratingEl.length) {
    const ratingText = ratingEl.text().trim();
    const parsed = parseInt(ratingText, 10);
    if (!isNaN(parsed)) {
      rating = parsed;
    }
  }
  logger.info('CodeChef rating parsed', { username, rating });

  // Parse highest rating (may be in different location)
  let highestRating: number | null = null;
  const highestEl = $('.rating-header .highest').first();
  if (highestEl.length) {
    const highestText = highestEl.text().replace(/[^0-9]/g, '');
    const parsed = parseInt(highestText, 10);
    if (!isNaN(parsed)) {
      highestRating = parsed;
    }
  }

  // Parse global rank (if available)
  let globalRank: string | null = null;
  const rankEl = $('.profile-loaction-item').filter(function() {
    return $(this).text().toLowerCase().includes('global rank');
  }).first();
  if (rankEl.length) {
    const rankText = rankEl.text();
    const rankMatch = rankText.match(/(\d+[\d,]*)/);
    if (rankMatch) {
      globalRank = rankMatch[1].replace(/,/g, '');
    }
  }

  // Parse total solved problems - selector: section.problems-solved h5
  let totalSolved = 0;
  const problemsSolvedEl = $('section.problems-solved h5').first();
  if (problemsSolvedEl.length) {
    const problemsText = problemsSolvedEl.text();
    // Text example: "Total Problems Solved: 277"
    const match = problemsText.match(/(\d+[\d,]*)/);
    if (match) {
      const parsed = parseInt(match[1].replace(/,/g, ''), 10);
      if (!isNaN(parsed)) {
        totalSolved = parsed;
      }
    }
  }

  // Fallback: also check for .problems-solved .heading
  if (totalSolved === 0) {
    const headingEl = $('.problems-solved .heading').first();
    if (headingEl.length) {
      const headingText = headingEl.text();
      const match = headingText.match(/(\d+[\d,]*)/);
      if (match) {
        const parsed = parseInt(match[1].replace(/,/g, ''), 10);
        if (!isNaN(parsed)) {
          totalSolved = parsed;
        }
      }
    }
  }

  // Final Regex Fallback (Robust Parsing)
  // ALWAYS prefer "Total Problems Solved" text if present, as it's the authoritative metric
  const solvedMatch = html.match(/Total Problems Solved\s*:?\s*([\d,]+)/i);
  if (solvedMatch) {
    const parsed = parseInt(solvedMatch[1].replace(/,/g, ''), 10);
    if (!isNaN(parsed) && parsed > 0) {
      totalSolved = parsed;
    }
  }

  if (!globalRank || globalRank === '0' || globalRank === '') {
    const globalMatch = html.match(/Global Rank:\s*(\d+)/i);
    if (globalMatch) globalRank = globalMatch[1];
  }

  let countryRank: string | null = null;
  const countryMatch = html.match(/Country Rank:\s*(\d+)/i);
  if (countryMatch) countryRank = countryMatch[1];

  // Parse stars (e.g., 1★, 2★)
  let stars: string | null = null;
  const starsEl = $('.rating-star').first();
  if (starsEl.length) {
    stars = starsEl.text().trim();
  }

  logger.info('CodeChef stats parsed', {
    username,
    totalSolved,
    rating,
    highestRating,
    globalRank,
    stars,
  });

  // Return empty state if no data found (user might exist but have no activity)
  if (rating === null && totalSolved === 0) {
    logger.warn('CodeChef user exists but no stats found - possible private profile or new user', { username });
  }

  return {
    username,
    totalSolved,
    easySolved: 0,
    mediumSolved: 0,
    hardSolved: 0,
    rating,
    rank: stars || globalRank, // Prefer star rating as display rank for CodeChef
    totalContests: 0,
    rawData: {
      rating,
      highestRating,
      globalRank,
      countryRank,
      stars,
      totalSolved,
      scrapedAt: new Date().toISOString(),
    },
  };
}

async function fetchGithubRealStats(username: string): Promise<FetchedPlatformStats> {
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
  const languageCounts: Record<string, number> = {};

  try {
    const reposRes = await fetchWithRetry(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`,
      { headers }
    );

    if (reposRes.ok) {
      const repos = await reposRes.json() as Array<Record<string, unknown>>;

      for (const repo of repos) {
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
      name: data.name ?? null,
      bio: data.bio ?? null,
      avatar_url: data.avatar_url ?? null,
      html_url: data.html_url ?? null,
      created_at: data.created_at ?? null,
      synced_at: new Date().toISOString(),
    },
  };
}

async function fetchRealStats(platformName: string, username: string): Promise<FetchedPlatformStats> {
  // All external fetches are wrapped in their circuit breaker so we fail fast
  // when a provider is down, instead of blocking the worker pool with timeouts.
  switch (platformName) {
    case 'leetcode':
      return circuitBreakers.leetcode.execute(() => fetchLeetCodeRealStats(username));
    case 'codeforces':
      return circuitBreakers.codeforces.execute(() => fetchCodeforcesRealStats(username));
    case 'codechef':
      return circuitBreakers.codechef.execute(() => fetchCodeChefRealStats(username));
    case 'github':
      return circuitBreakers.github.execute(() => fetchGithubRealStats(username));
    default:
      throw new Error(`Platform "${platformName}" sync not supported`);
  }
}

/**
 * Fetch unique solved problems from Codeforces user.status API
 * Pages through results in chunks of 5000 until no more submissions
 */
async function fetchUniqueSolvedProblems(handle: string): Promise<number> {
  const solvedProblems = new Set<string>();
  let from = 1;
  const count = 5000;

  while (true) {
    const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=${from}&count=${count}`;
    const res = await fetchWithRetry(url);

    if (!res.ok) {
      logger.warn(`Codeforces user.status API returned ${res.status} at from=${from}`);
      break;
    }

    const data = await res.json() as { status: string; result?: CodeforcesSubmissionBackend[] };
    if (data.status !== 'OK' || !data.result || data.result.length === 0) {
      break;
    }

    for (const submission of data.result) {
      if (submission.verdict === 'OK' && submission.problem) {
        const key = `${submission.problem.contestId ?? 'na'}-${submission.problem.index ?? submission.problem.name ?? 'na'}`;
        solvedProblems.add(key);
      }
    }

    if (data.result.length < count) {
      break;
    }

    from += count;
  }

  return solvedProblems.size;
}

export async function syncAllPlatforms(userId: string): Promise<SyncResult[]> {
  const t0 = Date.now();
  const platforms = await ConnectedPlatform.find({
    userId: new Types.ObjectId(userId),
    isConnected: true,
  });
  logger.perf('syncAllPlatforms_find_connected', Date.now() - t0, { userId, count: platforms.length });

  const results: SyncResult[] = [];

  for (const platform of platforms) {
    try {
      const result = await syncPlatform(userId, platform.platformName);
      results.push(result);
    } catch (error) {
      logger.error(`Sync failed for ${platform.platformName}`, error);
      results.push({
        platform: platform.platformName,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  // Log sync activity event
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  try {
    await createActivity(userId, {
      type: 'streak_milestone',
      title: 'Platform Sync',
      description: failed.length === 0
        ? `Synced ${succeeded.length} platform(s) successfully`
        : `Synced ${succeeded.length}/${results.length} platform(s). Failed: ${failed.map((f) => f.platform).join(', ')}`,
      platform: 'devtrack',
      url: null,
      tags: ['sync'],
      metadata: {
        platformsSynced: results.length,
        successCount: succeeded.length,
        failedCount: failed.length,
      },
    });
  } catch (err) {
    logger.warn('Failed to log sync activity event', { error: err instanceof Error ? err.message : String(err) });
  }

  return results;
}

export async function syncPlatform(userId: string, platformName: string): Promise<SyncResult> {
  // TASK 2: Acquire distributed mutex lock to prevent concurrent syncs
  // Prevents data corruption from concurrent writes
  const lockAcquired = await acquireSyncLockWithRetry(userId, platformName, 10);
  
  if (!lockAcquired) {
    logger.warn('[syncLock] Failed to acquire lock, rejecting sync', {
      event: 'sync_lock_rejected',
      userId,
      platformName,
    });
    return {
      platform: platformName,
      success: false,
      error: 'Another sync is already running for this platform. Please wait and try again.',
    };
  }

  try {
    // Execute actual sync with lock held
    const result = await syncPlatformWithLock(userId, platformName);
    // Both HTTP and worker syncs pass here, after ingestion and sync timestamps
    // are persisted. Refresh the whole user after any DSA provider succeeds.
    if (result.success && ['leetcode', 'codeforces', 'codechef'].includes(platformName)) {
      try {
        await getReadinessDsaQueue().add('post-sync-readiness', { userId, platform: platformName });
      } catch (error) {
        logger.warn('[sync] DSA readiness enqueue failed (non-fatal)', {
          userId, platform: platformName, error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  } finally {
    // Always release lock, even if sync fails
    try {
      await releaseSyncLock(userId, platformName);
      logger.info('[syncLock] Lock released', {
        event: 'sync_lock_released',
        userId,
        platformName,
      });
    } catch (releaseErr) {
      logger.error('[syncLock] Failed to release lock', releaseErr as Error, {
        userId,
        platformName,
        error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
  }
}

/**
 * Internal sync implementation — MUST be called with lock held
 * Do not call directly; use syncPlatform() which handles locking
 */
async function syncPlatformWithLock(userId: string, platformName: string): Promise<SyncResult> {
  const syncStartedAt = Date.now();
  const platform = await ConnectedPlatform.findOneAndUpdate(
    { userId: new Types.ObjectId(userId), platformName },
    { syncStatus: 'syncing', syncError: null },
    { new: true }
  );

  if (!platform) {
    return { platform: platformName, success: false, error: 'Platform not connected' };
  }

  // ─── Production Hardening: Cooldown Logic (5 minutes) ────────────────────
  const COOLDOWN_MS = 5 * 60 * 1000;
  const timeSinceLastSync = platform.lastSyncedAt ? Date.now() - new Date(platform.lastSyncedAt).getTime() : Infinity;

  if (timeSinceLastSync < COOLDOWN_MS && platform.syncStatus === 'success') {
    const remainingSec = Math.ceil((COOLDOWN_MS - timeSinceLastSync) / 1000);
    logger.info(`Sync cooldown active for ${platformName}`, { userId, remainingSec });
    return {
      platform: platformName,
      success: false,
      error: `Cooldown active. Please wait ${remainingSec}s before syncing ${platformName} again.`
    };
  }

  const job = await SyncJob.create({
    userId: new Types.ObjectId(userId),
    platformName: platformName as 'leetcode' | 'codeforces' | 'github' | 'codechef',
    status: 'running',
  });

  try {
    const fetched = await fetchRealStats(platformName, platform.username);

    await PlatformStats.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), platformName },
      {
        username: fetched.username,
        totalSolved: fetched.totalSolved,
        easySolved: fetched.easySolved,
        mediumSolved: fetched.mediumSolved,
        hardSolved: fetched.hardSolved,
        rating: fetched.rating,
        rank: fetched.rank,
        totalContests: fetched.totalContests,
        rawData: fetched.rawData,
        fetchedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Track sync as an active day
    try {
      await incrementDailyActivity(userId, new Date(), 'sync');
    } catch (actErr) {
      // Non-fatal
    }

    // TASK 2: Run DSA ingestion pipeline for non-GitHub/non-CodeChef platforms
    if (platformName !== 'github' && platformName !== 'codechef') {
      try {
        await ingestDsaData(userId, platformName, platform.username, fetched);
      } catch (ingestionErr) {
        logger.warn(`DSA ingestion failed for ${platformName} (non-fatal)`, {
          error: ingestionErr instanceof Error ? ingestionErr.message : String(ingestionErr),
        });
      }
    }

    // Generate GitHub sync completed activity
    if (platformName === 'github') {
      try {
        const raw = fetched.rawData as Record<string, unknown>;
        await createActivity(userId, {
          type: 'github_sync_completed',
          title: 'GitHub Profile Synced',
          description: `Synced ${raw.public_repos ?? 0} repos, ${raw.followers ?? 0} followers, ${raw.following ?? 0} following`,
          platform: 'github',
          url: (raw.html_url as string) ?? null,
          tags: ['sync', 'github'],
          metadata: {
            public_repos: Number(raw.public_repos ?? 0),
            followers: Number(raw.followers ?? 0),
            following: Number(raw.following ?? 0),
          },
        });
      } catch (err) {
        logger.warn('Failed to create GitHub sync activity (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await ConnectedPlatform.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), platformName },
      { syncStatus: 'success', lastSyncedAt: new Date(), syncError: null }
    );

    await SyncJob.findByIdAndUpdate(job._id, {
      status: 'completed',
      completedAt: new Date(),
      itemsProcessed: fetched.totalSolved,
      itemsUpdated: fetched.totalSolved,
    });

    const syncDurationMs = Date.now() - syncStartedAt;

    // Emit SSE completion event with actual duration
    eventBus.emitSyncCompleted(userId, platformName, {
      totalSolved: fetched.totalSolved,
      easySolved: fetched.easySolved,
      mediumSolved: fetched.mediumSolved,
      hardSolved: fetched.hardSolved,
      rating: fetched.rating ?? undefined,
      totalContests: fetched.totalContests,
    }, syncDurationMs);

    return {
      platform: platformName,
      success: true,
      stats: {
        totalSolved: fetched.totalSolved,
        easySolved: fetched.easySolved,
        mediumSolved: fetched.mediumSolved,
        hardSolved: fetched.hardSolved,
        rating: fetched.rating ?? undefined,
        rank: fetched.rank ?? undefined,
        totalContests: fetched.totalContests,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await ConnectedPlatform.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), platformName },
      { syncStatus: 'error', syncError: errorMessage }
    );

    await SyncJob.findByIdAndUpdate(job._id, {
      status: 'failed',
      completedAt: new Date(),
      errorMessage,
    });

    // Emit SSE failure event so the frontend can reflect the failed sync
    eventBus.emitSyncFailed(userId, platformName, errorMessage);

    return { platform: platformName, success: false, error: errorMessage };
  }
}

// ---------------------------------------------------------------------------
// SYNC STATUS — read-only (no external API calls)
// ---------------------------------------------------------------------------

export interface SyncStatusItem {
  platformName: string;
  username: string;
  isConnected: boolean;
  syncStatus: string;
  syncError: string | null;
  lastSyncedAt: string | null;
  stats: {
    totalSolved: number;
    easySolved: number;
    mediumSolved: number;
    hardSolved: number;
    rating: number | null;
    rank: string | null;
    totalContests: number;
  } | null;
}

export async function getSyncStatus(userId: string): Promise<SyncStatusItem[]> {
  const t0 = Date.now();
  const platforms = await ConnectedPlatform.find({
    userId: new Types.ObjectId(userId),
  });

  const results: SyncStatusItem[] = [];

  for (const platform of platforms) {
    const stats = await PlatformStats.findOne({
      userId: new Types.ObjectId(userId),
      platformName: platform.platformName,
    });

    results.push({
      platformName: platform.platformName,
      username: platform.username,
      isConnected: platform.isConnected,
      syncStatus: platform.syncStatus,
      syncError: platform.syncError,
      lastSyncedAt: platform.lastSyncedAt?.toISOString() ?? null,
      stats: stats
        ? {
            totalSolved: stats.totalSolved,
            easySolved: stats.easySolved,
            mediumSolved: stats.mediumSolved,
            hardSolved: stats.hardSolved,
            rating: stats.rating,
            rank: stats.rank,
            totalContests: stats.totalContests,
          }
        : null,
    });
  }

  logger.perf('getSyncStatus', Date.now() - t0, { userId, platforms: platforms.length });
  return results;
}

// ---------------------------------------------------------------------------
// TASK 2: DSA INGESTION PIPELINE
// ---------------------------------------------------------------------------
// platform sync → fetch submissions → persist DsaSubmission → persist DsaContest
// → update topic analytics → create activity events → dashboard aggregation
// ---------------------------------------------------------------------------

/**
 * Orchestrates DSA data ingestion after platform stats are synced.
 * Only runs for DSA platforms (non-GitHub). Non-fatal — errors are logged.
 */
async function ingestDsaData(
  userId: string,
  platformName: string,
  username: string,
  fetched: FetchedPlatformStats
): Promise<void> {
  // STEP 2.2+2.3 — Submission + Contest ingestion based on platform
  switch (platformName) {
    case 'codeforces':
      await ingestCodeforcesSubmissions(userId, username);
      await ingestCodeforcesContests(userId, fetched);
      break;
    case 'leetcode':
      await ingestLeetCodeSubmissions(userId, username);
      await ingestLeetCodeContests(userId, fetched);
      break;
    case 'codechef':
      await ingestCodeChefSubmissions(userId, username);
      break;
  }

  // STEP 2.4 — Update topic analytics from platform stats
  await updatePlatformTopicAnalytics(userId, platformName, fetched);

  // STEP 2.5 — Generate activity events for milestones
  await generateSyncActivityEvents(userId, platformName, fetched);

  logger.info(`DSA ingestion completed for ${platformName}`, { userId, totalSolved: fetched.totalSolved });
}

/**
 * STEP 2.2: Ingest recent Codeforces submissions into DsaSubmission.
 * Deduplication by userId + platform + submittedAt timestamp.
 */
async function ingestCodeforcesSubmissions(userId: string, handle: string): Promise<number> {
  const userObjId = new Types.ObjectId(userId);
  let ingested = 0;
  let totalFetched = 0;
  let parsed = 0;
  let duplicates = 0;
  let failed = 0;
  let skipped = 0;

  // Rolling 365-day cutoff
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 364);
  cutoff.setHours(0, 0, 0, 0);

  try {
    logger.info('Codeforces submission ingestion started (365-day window)', { userId, handle });

    // Paginate through user.status until we pass the 365-day cutoff
    let from = 1;
    const pageSize = 1000;
    let reachedCutoff = false;

    while (!reachedCutoff) {
      const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=${from}&count=${pageSize}`;
      const res = await fetchWithTimeout(url);

      if (!res.ok) {
        logger.warn('Codeforces submissions API returned non-ok status', { userId, handle, status: res.status, from });
        break;
      }

      const data = await res.json() as { status: string; result?: CodeforcesSubmissionBackend[] };

      if (data.status !== 'OK' || !data.result || data.result.length === 0) {
        break;
      }

      logger.info('Codeforces submissions page received', { userId, handle, from, count: data.result.length });

      for (const sub of data.result) {
        // Check if submission is before cutoff
        const submittedAt = sub.creationTimeSeconds
          ? new Date(sub.creationTimeSeconds * 1000)
          : null;

        if (!submittedAt || submittedAt < cutoff) {
          reachedCutoff = true;
          break;
        }

        totalFetched++;

        if (!sub.problem) {
          skipped++;
          continue;
        }

        // Ingest ALL verdicts — skip only if verdict is missing entirely
        if (!sub.verdict) {
          skipped++;
          continue;
        }

        parsed++;

        // Use Codeforces submission id as externalId for proper unique index dedup
        const externalId = String(sub.id);
        const problemKey = `${sub.problem.contestId ?? 'na'}-${sub.problem.index ?? 'na'}`;

        // Fast dedup via unique index: try create, skip on duplicate key error
        let problem = await DsaProblem.findOne({
          userId: userObjId,
          externalId: problemKey,
          platform: 'codeforces',
        });

        if (!problem) {
          try {
            problem = await DsaProblem.create({
              userId: userObjId,
              externalId: problemKey,
              title: sub.problem.name ?? 'Unknown',
              platform: 'codeforces',
              difficulty: 'medium',
              url: sub.problem.contestId
                ? `https://codeforces.com/problemset/problem/${sub.problem.contestId}/${sub.problem.index}`
                : 'https://codeforces.com',
              tags: [],
              category: 'Competitive',
              status: sub.verdict === 'OK' ? 'solved' : 'attempted',
              submissionCount: 1,
              isFavorite: false,
            });
          } catch (createErr: any) {
            // Handle duplicate key for problem (race condition)
            if (createErr?.code === 11000) {
              problem = await DsaProblem.findOne({
                userId: userObjId,
                externalId: problemKey,
                platform: 'codeforces',
              });
              if (!problem) {
                failed++;
                continue;
              }
            } else {
              failed++;
              logger.warn('Failed to create Codeforces problem', { userId, handle, problemKey, error: createErr instanceof Error ? createErr.message : String(createErr) });
              continue;
            }
          }
        }

        const status: 'accepted' | 'wrong' | 'time_limit_exceeded' | 'runtime_error' | 'compilation_error' =
          sub.verdict === 'OK' ? 'accepted'
            : sub.verdict === 'TIME_LIMIT_EXCEEDED' ? 'time_limit_exceeded'
            : sub.verdict === 'RUNTIME_ERROR' ? 'runtime_error'
            : sub.verdict === 'COMPILATION_ERROR' ? 'compilation_error'
            : 'wrong';

        try {
          await DsaSubmission.create({
            userId: userObjId,
            problemId: problem._id,
            platform: 'codeforces',
            externalId,
            status,
            language: sub.language ?? 'unknown',
            codeSnippet: null,
            submittedAt,
            executionTime: null,
            memoryUsed: null,
          });

          // Update heatmap (consistency graph)
          try {
            await incrementDailyActivity(userId, submittedAt, 'submission');
          } catch (actErr) {
            // Non-fatal
          }

          if (sub.verdict === 'OK' && problem.status !== 'solved') {
            await DsaProblem.findByIdAndUpdate(problem._id, {
              status: 'solved',
              solvedAt: submittedAt,
              lastSubmittedAt: submittedAt,
              $inc: { submissionCount: 1 },
            });
          } else {
            // Update submission count for attempted problems
            await DsaProblem.findByIdAndUpdate(problem._id, {
              $inc: { submissionCount: 1 },
              lastSubmittedAt: submittedAt,
            });
          }

          ingested++;

          if (sub.verdict === 'OK') {
            const { checkChallengeCompletion } = await import('../daily-challenge/daily-challenge.service.js');
            void checkChallengeCompletion(userId, 'codeforces', problemKey);
          }
        } catch (subErr: any) {
          // Duplicate key on unique index (userId + platform + externalId) → skip
          if (subErr?.code === 11000) {
            duplicates++;
          } else {
            failed++;
            logger.warn('Failed to create Codeforces submission', {
              userId,
              handle,
              problemKey,
              error: subErr instanceof Error ? subErr.message : String(subErr),
            });
          }
        }
      }

      // If we got fewer results than requested, we've seen all submissions
      if (data.result.length < pageSize) {
        break;
      }

      from += pageSize;
    }
  } catch (err) {
    logger.warn('Codeforces submission ingestion failed', {
      userId,
      handle,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Log ingestion summary
  logger.info('Codeforces submission ingestion summary', {
    userId,
    handle,
    totalFetched,
    parsed,
    ingested,
    duplicates,
    failed,
    skipped,
  });

  return ingested;
}

/**
 * STEP 2.3: Ingest Codeforces contests from rating history.
 * Deduplication by userId + platform + contestName.
 */
async function ingestCodeforcesContests(userId: string, fetched: FetchedPlatformStats): Promise<number> {
  const userObjId = new Types.ObjectId(userId);
  let ingested = 0;

  const ratingHistory = (fetched.rawData?.ratingHistory ?? []) as CodeforcesRatingChange[];

  for (const contest of ratingHistory) {
    const participatedAt = new Date(contest.ratingUpdateTimeSeconds * 1000);

    const exists = await DsaContest.findOne({
      userId: userObjId,
      platform: 'codeforces',
      contestName: contest.contestName,
    }).lean();
    if (exists) continue;

    await DsaContest.create({
      userId: userObjId,
      platform: 'codeforces',
      contestName: contest.contestName,
      rank: contest.rank,
      totalParticipants: null,
      problemsSolved: 0,
      ratingBefore: contest.oldRating,
      ratingAfter: contest.newRating,
      ratingChange: contest.newRating - contest.oldRating,
      participatedAt,
    });
    ingested++;
  }

  if (ingested > 0) {
    logger.info(`Ingested ${ingested} Codeforces contests`, { userId });
  }
  return ingested;
}

// ---------------------------------------------------------------------------
// LEETCODE INGESTION
// ---------------------------------------------------------------------------
interface LeetCodeSubmission {
  id: string;
  title: string;
  titleSlug: string;
  timestamp: string;
}

interface LeetCodeContest {
  title: string;
  startTime: number;
  participantCount: number;
}

export async function ingestLeetCodeSubmissions(userId: string, username: string): Promise<number> {
  const userObjId = new Types.ObjectId(userId);
  let ingested = 0;
  let fetched = 0;
  let parsed = 0;
  let duplicates = 0;
  let failed = 0;
  let skipped = 0;
  let latestTitle = '';
  let latestTimestamp: number | null = null;

  try {
    logger.info('LeetCode submission ingestion started', { userId, username });

    // Fetch last 500 accepted submissions — enough for ~3 months of daily activity
    const query = `
      query recentAcSubmissions($username: String!, $limit: Int!) {
        recentAcSubmissionList(username: $username, limit: $limit) {
          id
          title
          titleSlug
          timestamp
        }
      }
    `;

    const response = await fetchLeetCodeGraphQL(query, { username, limit: 500 });
    const submissions = response.data?.recentAcSubmissionList;

    if (!Array.isArray(submissions)) {
      logger.error('LeetCode submissions response format unexpected', { userId, username });
      return 0;
    }

    fetched = submissions.length;

    for (const sub of submissions) {
      // Skip invalid submissions
      if (!sub.title || !sub.timestamp || !sub.id) {
        skipped++;
        continue;
      }

      parsed++;

      // Track latest submission for audit
      const ts = parseInt(sub.timestamp);
      if (!latestTimestamp || ts > latestTimestamp) {
        latestTimestamp = ts;
        latestTitle = sub.title;
      }

      const submittedAt = new Date(ts * 1000);
      if (isNaN(submittedAt.getTime())) {
        skipped++;
        continue;
      }

      // Deduplication check
      const externalId = sub.id;
      const existingSub = await DsaSubmission.findOne({
        userId: userObjId,
        platform: 'leetcode',
        externalId,
      }).lean();

      if (existingSub) {
        duplicates++;
        continue;
      }

      const problemKey = sub.titleSlug;

      // Atomic upsert — single DB round-trip, dedup via unique index on failure
      let upserted = await DsaProblem.findOneAndUpdate(
        { userId: userObjId, externalId: problemKey, platform: 'leetcode' },
        {
          $setOnInsert: {
            title: sub.title,
            difficulty: 'medium',
            url: `https://leetcode.com/problems/${sub.titleSlug}`,
            tags: [],
            category: 'Data Structures & Algorithms',
            status: 'solved',
            submissionCount: 1,
            isFavorite: false,
          },
          $inc: { submissionCount: 1 },
          $set: { lastSubmittedAt: submittedAt },
        },
        { upsert: true, new: true }
      );

      if (!upserted) {
        failed++;
        continue;
      }

      // If this is a newly upserted problem (wasn't solved), mark it solved
      if (upserted.status !== 'solved') {
        upserted = await DsaProblem.findByIdAndUpdate(upserted._id, {
          status: 'solved',
          solvedAt: submittedAt,
        }, { new: true }) as typeof upserted;
      }

      // Atomic submission insert — skip duplicate key errors silently
      try {
        await DsaSubmission.create({
          userId: userObjId,
          problemId: upserted._id,
          platform: 'leetcode',
          externalId,
          status: 'accepted',
          language: 'unknown',
          codeSnippet: null,
          submittedAt,
          executionTime: null,
          memoryUsed: null,
        });

        try {
          await incrementDailyActivity(userId, submittedAt, 'submission');
        } catch (actErr) {
          // Non-fatal
        }

        ingested++;

        const { checkChallengeCompletion } = await import('../daily-challenge/daily-challenge.service.js');
        void checkChallengeCompletion(userId, 'leetcode', problemKey);
      } catch (createErr: any) {
        if (createErr?.code === 11000) {
          duplicates++;
        } else {
          failed++;
          logger.warn('Failed to create LeetCode submission', {
            userId,
            username,
            problemKey,
            error: createErr instanceof Error ? createErr.message : String(createErr),
          });
        }
      }
    }
  } catch (err) {
    logger.warn('LeetCode submission ingestion failed', {
      userId,
      username,
      error: err instanceof Error ? err.message : String(err),
    });
  }


  logger.info('LeetCode submission ingestion summary', {
    userId,
    username,
    fetched,
    parsed,
    ingested,
    duplicates,
    failed,
    skipped,
    latestSubmissionTitle: latestTitle,
    latestSubmissionTimestamp: latestTimestamp ? new Date(latestTimestamp * 1000).toISOString() : null,
    ingestRatio: fetched > 0 ? `${ingested}/${fetched} persisted` : 'no submissions fetched',
  });

  return ingested;
}

export async function ingestLeetCodeContests(userId: string, fetched: FetchedPlatformStats): Promise<number> {
  const userObjId = new Types.ObjectId(userId);
  let ingested = 0;

  try {
    const username = fetched.username;
    const res = await fetchWithTimeout(
      `https://alfa-leetcode-api.onrender.com/${encodeURIComponent(username)}/contest`
    );
    if (!res.ok) return 0;

    const data = await res.json() as Record<string, unknown>;
    const contestHistory = (data.contestHistory ?? []) as LeetCodeContest[];

    for (const contest of contestHistory) {
      if (!contest.title) continue;

      const participatedAt = new Date(contest.startTime * 1000);

      const exists = await DsaContest.findOne({
        userId: userObjId,
        platform: 'leetcode',
        contestName: contest.title,
      }).lean();
      if (exists) continue;

      await DsaContest.create({
        userId: userObjId,
        platform: 'leetcode',
        contestName: contest.title,
        rank: null,
        totalParticipants: contest.participantCount ?? null,
        problemsSolved: 0,
        ratingBefore: null,
        ratingAfter: null,
        ratingChange: null,
        participatedAt,
      });
      ingested++;
    }
  } catch (err) {
    logger.warn('LeetCode contest ingestion error (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (ingested > 0) {
    logger.info(`Ingested ${ingested} LeetCode contests`, { userId });
  }
  return ingested;
}

// ---------------------------------------------------------------------------
// CODECHEF INGESTION
// ---------------------------------------------------------------------------

async function ingestCodeChefSubmissions(userId: string, username: string): Promise<number> {
  // CodeChef submissions API (codechef-api.vercel.app) is dead - skip ingestion gracefully
  // Stats are still synced via profile scraping, but individual submissions won't be ingested
  // This is a TEMPORARY SAFE FALLBACK per prompt.md requirements
  logger.info('CodeChef submission ingestion skipped - external API unavailable', { userId, username });
  return 0;
}


/**
 * STEP 2.4: Update DsaTopicProgress from platform sync data.
 * Incremental upsert per platform topic.
 */
async function updatePlatformTopicAnalytics(
  userId: string,
  platformName: string,
  fetched: FetchedPlatformStats
): Promise<void> {
  const userObjId = new Types.ObjectId(userId);

  const topicName = platformName === 'codeforces' ? 'Competitive Programming'
    : platformName === 'leetcode' ? 'LeetCode Problems'
    : platformName === 'codechef' ? 'CodeChef Problems'
    : 'General';

  await DsaTopicProgress.findOneAndUpdate(
    { userId: userObjId, topicName },
    {
      $set: {
        totalProblems: fetched.totalSolved,
        solvedCount: fetched.totalSolved,
        easyCount: fetched.easySolved,
        easySolved: fetched.easySolved,
        mediumCount: fetched.mediumSolved,
        mediumSolved: fetched.mediumSolved,
        hardCount: fetched.hardSolved,
        hardSolved: fetched.hardSolved,
      },
    },
    { upsert: true, new: true }
  );
}

/**
 * STEP 2.5: Generate activity events for milestones and recent contests.
 */
async function generateSyncActivityEvents(
  userId: string,
  platformName: string,
  fetched: FetchedPlatformStats
): Promise<void> {
  const { ActivityEvent } = await import('../../db/models/index.js');

  // Milestone achievements (every 50/100/200/... solved)
  const milestones = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000];
  for (const milestone of milestones) {
    if (fetched.totalSolved >= milestone) {
      const existing = await ActivityEvent.findOne({
        userId: new Types.ObjectId(userId),
        type: 'streak_milestone',
        'metadata.milestone': milestone,
        'metadata.platform': platformName,
      }).lean();

      if (!existing) {
        try {
          await createActivity(userId, {
            type: 'streak_milestone',
            title: `Reached ${milestone} solved problems`,
            description: `Solved ${milestone} problems on ${platformName}!`,
            platform: platformName,
            url: null,
            tags: ['milestone', platformName],
            metadata: { milestone, platform: platformName, totalSolved: fetched.totalSolved },
          });
        } catch (err) {
          logger.warn('[sync] Failed to create milestone activity', { userId, milestone, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  // Recent contest participation activity
  const ratingHistory = (fetched.rawData?.ratingHistory ?? []) as CodeforcesRatingChange[];
  if (ratingHistory.length > 0) {
    const lastContest = ratingHistory[ratingHistory.length - 1];
    const contestDate = new Date(lastContest.ratingUpdateTimeSeconds * 1000);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    if (contestDate >= sevenDaysAgo) {
      const existing = await ActivityEvent.findOne({
        userId: new Types.ObjectId(userId),
        type: 'contest_participated',
        'metadata.contestName': lastContest.contestName,
      }).lean();

      if (!existing) {
        const ratingChange = lastContest.newRating - lastContest.oldRating;
        try {
          await createActivity(userId, {
            type: 'contest_participated',
            title: `Participated in ${lastContest.contestName}`,
            description: ratingChange >= 0
              ? `Rating increased by ${ratingChange} (${lastContest.oldRating} → ${lastContest.newRating})`
              : `Rating changed by ${ratingChange} (${lastContest.oldRating} → ${lastContest.newRating})`,
            platform: platformName,
            url: `https://codeforces.com/contest/${lastContest.contestId}`,
            tags: ['contest', platformName],
            metadata: { contestName: lastContest.contestName, rank: lastContest.rank, ratingChange, newRating: lastContest.newRating },
          });
        } catch (err) {
          logger.warn('[sync] Failed to create contest activity', { userId, contestName: lastContest.contestName, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
}
