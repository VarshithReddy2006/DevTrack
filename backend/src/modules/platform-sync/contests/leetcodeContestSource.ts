import { fetchWithTimeout } from '../../../shared/fetchWithTimeout.js';
import { circuitBreakers } from '../../../shared/circuit-breaker/circuitBreaker.js';
import { logger } from '../../../shared/logger.js';
import type { ContestPhase, ContestSource, UpcomingContest } from './ContestSource.js';

interface LeetCodeGraphQLContest {
  title: string;
  titleSlug?: string;
  startTime: number;
  duration: number;
  cardImg?: string;
}

interface LeetCodeGraphQLResponse {
  data?: {
    topTwoContests?: LeetCodeGraphQLContest[];
    upcomingContests?: LeetCodeGraphQLContest[];
    allContests?: LeetCodeGraphQLContest[];
  };
  errors?: Array<{ message: string }>;
}

const UPCOMING_CONTESTS_QUERY = `
  query upcomingContests {
    topTwoContests {
      title
      titleSlug
      startTime
      duration
      cardImg
    }
  }
`;

export class LeetCodeContestSource implements ContestSource {
  readonly platform = 'leetcode' as const;

  async fetchUpcoming(signal?: AbortSignal): Promise<UpcomingContest[]> {
    return circuitBreakers.leetcode.execute(async () => {
      const url = 'https://leetcode.com/graphql';
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Referer': 'https://leetcode.com/contest/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({
          query: UPCOMING_CONTESTS_QUERY,
          variables: {},
        }),
        timeoutMs: 10_000,
        signal,
      });

      if (!res.ok) {
        throw new Error(`LeetCode GraphQL HTTP ${res.status}`);
      }

      const body = (await res.json()) as LeetCodeGraphQLResponse;
      if (body.errors && body.errors.length > 0) {
        throw new Error(`LeetCode GraphQL error: ${body.errors[0]?.message || 'Unknown GraphQL error'}`);
      }

      const list = body.data?.topTwoContests || body.data?.upcomingContests || body.data?.allContests;
      if (!Array.isArray(list)) {
        throw new Error('Invalid LeetCode contests response format');
      }

      const now = Date.now();
      const upcoming: UpcomingContest[] = list
        .filter((c) => Boolean(c.title && typeof c.startTime === 'number' && typeof c.duration === 'number'))
        .map((c) => {
          const startTime = new Date(c.startTime * 1000);
          const durationSeconds = c.duration;
          const endTime = new Date(startTime.getTime() + durationSeconds * 1000);
          const phase: ContestPhase = now < startTime.getTime() ? 'BEFORE' : now < endTime.getTime() ? 'CODING' : 'FINISHED';

          const slug = c.titleSlug || c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

          return {
            platform: this.platform,
            externalId: slug,
            contestName: c.title,
            startTime,
            endTime,
            durationSeconds,
            url: `https://leetcode.com/contest/${slug}/`,
            phase,
            kind: 'scheduled' as const,
            stale: false,
            fetchedAt: new Date(),
          };
        })
        .filter((c) => c.endTime.getTime() >= now);

      upcoming.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      logger.info(`[contest-source] LeetCode ingested ${upcoming.length} upcoming contests`);
      return upcoming;
    });
  }
}

export const leetcodeContestSource = new LeetCodeContestSource();
