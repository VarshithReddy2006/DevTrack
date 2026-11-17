import { fetchWithTimeout } from '../../../shared/fetchWithTimeout.js';
import { circuitBreakers } from '../../../shared/circuit-breaker/circuitBreaker.js';
import { logger } from '../../../shared/logger.js';
import type { ContestPhase, ContestSource, UpcomingContest } from './ContestSource.js';

interface CodeChefContestEntry {
  contest_code: string;
  contest_name: string;
  contest_start_date?: string;
  contest_end_date?: string;
  contest_start_date_iso?: string;
  contest_end_date_iso?: string;
  contest_duration?: string | number;
}

interface CodeChefApiResponse {
  status: string;
  future_contests?: CodeChefContestEntry[];
  present_contests?: CodeChefContestEntry[];
}

export class CodeChefContestSource implements ContestSource {
  readonly platform = 'codechef' as const;

  async fetchUpcoming(signal?: AbortSignal): Promise<UpcomingContest[]> {
    return circuitBreakers.codechef.execute(async () => {
      const url = 'https://www.codechef.com/api/list/contests/all?sort_by=START&sorting_order=asc&offset=0&mode=all';
      const res = await fetchWithTimeout(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'DevTrack-Contest-Ingestion/2.0',
        },
        timeoutMs: 10_000,
        signal,
      });

      if (!res.ok) {
        throw new Error(`CodeChef contest API HTTP ${res.status}`);
      }

      const body = (await res.json()) as CodeChefApiResponse;
      if (body.status !== 'success') {
        throw new Error(`CodeChef API returned non-success status: ${body.status}`);
      }

      const now = Date.now();
      const rawList: Array<{ entry: CodeChefContestEntry; isFuture: boolean }> = [
        ...(body.present_contests || []).map((entry) => ({ entry, isFuture: false })),
        ...(body.future_contests || []).map((entry) => ({ entry, isFuture: true })),
      ];

      const upcoming: UpcomingContest[] = [];

      for (const { entry, isFuture } of rawList) {
        if (!entry.contest_code || !entry.contest_name) continue;

        const startRaw = entry.contest_start_date_iso || entry.contest_start_date;
        const endRaw = entry.contest_end_date_iso || entry.contest_end_date;
        if (!startRaw) continue;

        const startTime = new Date(startRaw);
        if (Number.isNaN(startTime.getTime())) continue;

        let endTime: Date;
        let durationSeconds = 2 * 3600; // 2 hour default

        if (entry.contest_duration) {
          const parsedMin = parseInt(String(entry.contest_duration), 10);
          if (!Number.isNaN(parsedMin) && parsedMin > 0) {
            durationSeconds = parsedMin * 60;
          }
        }

        if (endRaw) {
          const parsedEnd = new Date(endRaw);
          if (!Number.isNaN(parsedEnd.getTime())) {
            endTime = parsedEnd;
            durationSeconds = Math.max(1, Math.round((endTime.getTime() - startTime.getTime()) / 1000));
          } else {
            endTime = new Date(startTime.getTime() + durationSeconds * 1000);
          }
        } else {
          endTime = new Date(startTime.getTime() + durationSeconds * 1000);
        }

        if (endTime.getTime() < now) continue;

        const phase: ContestPhase = isFuture ? 'BEFORE' : 'CODING';

        upcoming.push({
          platform: this.platform,
          externalId: entry.contest_code,
          contestName: entry.contest_name,
          startTime,
          endTime,
          durationSeconds,
          url: `https://www.codechef.com/${entry.contest_code}`,
          phase,
          kind: 'scheduled' as const,
          stale: false,
          fetchedAt: new Date(),
        });
      }

      upcoming.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      logger.info(`[contest-source] CodeChef ingested ${upcoming.length} upcoming contests`);
      return upcoming;
    });
  }
}

export const codechefContestSource = new CodeChefContestSource();
