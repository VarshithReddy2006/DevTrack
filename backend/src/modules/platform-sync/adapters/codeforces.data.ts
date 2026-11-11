import { logger } from '../../../shared/logger.js';
import { fetchWithRetry } from './http.js';
import type { FetchedPlatformStats } from './types.js';

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

export async function fetchStatsData(username: string): Promise<FetchedPlatformStats> {
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
