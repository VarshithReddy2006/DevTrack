import { logger } from '../../../shared/logger.js';
import { fetchWithRetry } from './http.js';
import type { FetchedPlatformStats } from './types.js';

export async function fetchLeetCodeGraphQL(query: string, variables: Record<string, any>): Promise<any> {
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

  const response = await res.json();
  if (response.errors?.length) throw new Error('LeetCode GraphQL returned errors');
  return response;
}

export async function fetchStatsData(username: string): Promise<FetchedPlatformStats> {
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
