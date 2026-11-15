import { fetchWithTimeout } from '../../../shared/fetchWithTimeout.js';
import { circuitBreakers } from '../../../shared/circuit-breaker/circuitBreaker.js';
import { logger } from '../../../shared/logger.js';
import type { ContestSource, UpcomingContest } from './ContestSource.js';

interface CodeforcesContestApiEntry {
  id: number;
  name: string;
  type: string;
  phase: 'BEFORE' | 'CODING' | 'PENDING_SYSTEM_TEST' | 'SYSTEM_TEST' | 'FINISHED';
  frozen: boolean;
  durationSeconds: number;
  startTimeSeconds?: number;
  relativeTimeSeconds?: number;
}

interface CodeforcesApiResponse {
  status: string;
  comment?: string;
  result?: CodeforcesContestApiEntry[];
}

export class CodeforcesContestSource implements ContestSource {
  readonly platform = 'codeforces' as const;

  async fetchUpcoming(signal?: AbortSignal): Promise<UpcomingContest[]> {
    return circuitBreakers.codeforces.execute(async () => {
      const url = 'https://codeforces.com/api/contest.list?gym=false';
      const res = await fetchWithTimeout(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'DevTrack-Contest-Ingestion/2.0',
        },
        timeoutMs: 10_000,
        signal,
      });

      if (!res.ok) {
        throw new Error(`Codeforces contest API HTTP ${res.status}`);
      }

      const body = (await res.json()) as CodeforcesApiResponse;
      if (body.status !== 'OK' || !Array.isArray(body.result)) {
        throw new Error(`Codeforces API returned status ${body.status}: ${body.comment || 'Unknown error'}`);
      }

      const now = Date.now();
      const filtered = body.result.filter((c) => {
        if (!c.id || !c.name || typeof c.durationSeconds !== 'number') return false;
        if (c.phase === 'BEFORE' || c.phase === 'CODING') return true;
        if (c.startTimeSeconds) {
          const endMs = (c.startTimeSeconds + c.durationSeconds) * 1000;
          return endMs >= now && c.phase !== 'FINISHED';
        }
        return false;
      });

      const upcoming: UpcomingContest[] = filtered.map((c) => {
        const startSec = c.startTimeSeconds ?? Math.floor(now / 1000);
        const startTime = new Date(startSec * 1000);
        const durationSeconds = c.durationSeconds;
        const endTime = new Date(startTime.getTime() + durationSeconds * 1000);

        return {
          platform: this.platform,
          externalId: String(c.id),
          contestName: c.name,
          startTime,
          endTime,
          durationSeconds,
          url: `https://codeforces.com/contests/${c.id}`,
          phase: c.phase === 'BEFORE' ? 'BEFORE' : 'CODING',
          kind: 'scheduled' as const,
          stale: false,
          fetchedAt: new Date(),
        };
      });

      upcoming.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      logger.info(`[contest-source] Codeforces ingested ${upcoming.length} upcoming contests`);
      return upcoming;
    });
  }
}

export const codeforcesContestSource = new CodeforcesContestSource();
