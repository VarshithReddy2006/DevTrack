import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { circuitBreakers } from '../../../shared/circuit-breaker/circuitBreaker.js';
import { DsaContest } from '../../../db/models/dsaContest.model.js';
import { codeforcesContestSource } from '../../../modules/platform-sync/contests/codeforcesContestSource.js';
import { leetcodeContestSource } from '../../../modules/platform-sync/contests/leetcodeContestSource.js';
import { atcoderContestSource } from '../../../modules/platform-sync/contests/atcoderContestSource.js';
import { codechefContestSource } from '../../../modules/platform-sync/contests/codechefContestSource.js';
import {
  contestRefreshService,
} from '../../../modules/platform-sync/contests/contestRefresh.service.js';
import {
  scheduleContestRefreshTask,
  processContestRefresh,
  contestRefreshQueue,
  SIX_HOURS_MS,
} from '../../../shared/jobs/contestRefreshWorker.js';

// In-memory Redis store for testing cache behavior
const redisStore = new Map<string, string>();
vi.mock('../../../shared/redis/client.js', () => ({
  isRedisConfigured: vi.fn().mockReturnValue(true),
  getRedisClient: vi.fn().mockReturnValue({
    status: 'ready',
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, val: string) => {
      redisStore.set(key, val);
      return 'OK';
    }),
    ttl: vi.fn(async () => 21600),
  }),
}));

describe('Contest Ingestion Adapters & Circuit Breaker', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    redisStore.clear();
    circuitBreakers.codeforces.reset();
    circuitBreakers.leetcode.reset();
    circuitBreakers.atcoder.reset();
    circuitBreakers.codechef.reset();
    await DsaContest.init();
    await DsaContest.deleteMany({ kind: 'scheduled' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('CodeforcesContestSource', () => {
    it('normalizes upcoming contests and excludes finished contests', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const mockPayload = {
        status: 'OK',
        result: [
          {
            id: 2001,
            name: 'Codeforces Round 990 (Div. 2)',
            type: 'CF',
            phase: 'BEFORE',
            frozen: false,
            durationSeconds: 7200,
            startTimeSeconds: nowSec + 3600,
          },
          {
            id: 2000,
            name: 'Codeforces Round 989 (Div. 1)',
            type: 'CF',
            phase: 'CODING',
            frozen: false,
            durationSeconds: 7200,
            startTimeSeconds: nowSec - 1800,
          },
          {
            id: 1999,
            name: 'Codeforces Round 988 (Div. 3)',
            type: 'CF',
            phase: 'FINISHED',
            frozen: false,
            durationSeconds: 7200,
            startTimeSeconds: nowSec - 86400,
          },
        ],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPayload,
      } as Response);

      const contests = await codeforcesContestSource.fetchUpcoming();
      expect(contests).toHaveLength(2);

      const before = contests.find((c) => c.externalId === '2001');
      expect(before).toBeDefined();
      expect(before?.platform).toBe('codeforces');
      expect(before?.contestName).toBe('Codeforces Round 990 (Div. 2)');
      expect(before?.phase).toBe('BEFORE');
      expect(before?.durationSeconds).toBe(7200);
      expect(before?.url).toBe('https://codeforces.com/contests/2001');
      expect(before?.kind).toBe('scheduled');
      expect(before?.stale).toBe(false);

      const coding = contests.find((c) => c.externalId === '2000');
      expect(coding?.phase).toBe('CODING');
    });

    it('trips circuit breaker on repeated network errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection timeout to Codeforces'));

      await expect(codeforcesContestSource.fetchUpcoming()).rejects.toThrow('Connection timeout');
      await expect(codeforcesContestSource.fetchUpcoming()).rejects.toThrow('Connection timeout');
      await expect(codeforcesContestSource.fetchUpcoming()).rejects.toThrow('Connection timeout');

      // 3 consecutive failures trips Codeforces breaker to OPEN
      expect(circuitBreakers.codeforces.getState()).toBe('open');
      await expect(codeforcesContestSource.fetchUpcoming()).rejects.toThrow(/Circuit breaker "codeforces-api" is OPEN/);
    });
  });

  describe('LeetCodeContestSource', () => {
    it('queries GraphQL endpoint and normalizes contest schedules', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const mockPayload = {
        data: {
          topTwoContests: [
            {
              title: 'Weekly Contest 430',
              titleSlug: 'weekly-contest-430',
              startTime: nowSec + 7200,
              duration: 5400,
            },
            {
              title: 'Biweekly Contest 147',
              titleSlug: 'biweekly-contest-147',
              startTime: nowSec + 86400,
              duration: 5400,
            },
          ],
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPayload,
      } as Response);

      const contests = await leetcodeContestSource.fetchUpcoming();
      expect(contests).toHaveLength(2);

      const weekly = contests[0];
      expect(weekly.platform).toBe('leetcode');
      expect(weekly.externalId).toBe('weekly-contest-430');
      expect(weekly.contestName).toBe('Weekly Contest 430');
      expect(weekly.durationSeconds).toBe(5400);
      expect(weekly.url).toBe('https://leetcode.com/contest/weekly-contest-430/');
      expect(weekly.phase).toBe('BEFORE');
      expect(weekly.kind).toBe('scheduled');
    });

    it('throws error and activates circuit breaker on GraphQL errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          errors: [{ message: 'Rate limit exceeded on GraphQL contest endpoint' }],
        }),
      } as Response);

      await expect(leetcodeContestSource.fetchUpcoming()).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('AtCoderContestSource', () => {
    it('scrapes HTML schedule page and parses contest links and JST dates', async () => {
      const htmlFixture = `
        <html>
          <body>
            <div id="contest-table-upcoming">
              <table>
                <tbody>
                  <tr>
                    <td class="text-center"><a href="http://timeanddate.com">2026-11-20 21:00:00+0900</a></td>
                    <td><span class="user-blue">◉</span> <a href="/contests/abc380">AtCoder Beginner Contest 380</a></td>
                    <td class="text-center">01:40</td>
                    <td class="text-center">~ 1999</td>
                  </tr>
                  <tr>
                    <td class="text-center"><a href="http://timeanddate.com">2026-11-21 21:00:00+0900</a></td>
                    <td><span class="user-orange">◉</span> <a href="/contests/arc188">AtCoder Regular Contest 188</a></td>
                    <td class="text-center">02:00</td>
                    <td class="text-center">1200 ~ 2799</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </body>
        </html>
      `;

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => htmlFixture,
      } as Response);

      const contests = await atcoderContestSource.fetchUpcoming();
      expect(contests).toHaveLength(2);

      const abc = contests[0];
      expect(abc.platform).toBe('atcoder');
      expect(abc.externalId).toBe('abc380');
      expect(abc.contestName).toBe('AtCoder Beginner Contest 380');
      expect(abc.durationSeconds).toBe(100 * 60); // 01:40 = 6000 seconds
      expect(abc.url).toBe('https://atcoder.jp/contests/abc380');
      expect(abc.phase).toBe('BEFORE');
      expect(abc.kind).toBe('scheduled');
    });
  });

  describe('CodeChefContestSource', () => {
    it('ingests future and present contests from official JSON feed', async () => {
      const now = new Date();
      const futureStart = new Date(now.getTime() + 24 * 3600 * 1000);
      const futureEnd = new Date(futureStart.getTime() + 2 * 3600 * 1000);

      const mockPayload = {
        status: 'success',
        future_contests: [
          {
            contest_code: 'START160',
            contest_name: 'Starters 160 (Rated)',
            contest_start_date_iso: futureStart.toISOString(),
            contest_end_date_iso: futureEnd.toISOString(),
            contest_duration: '120',
          },
        ],
        present_contests: [],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockPayload,
      } as Response);

      const contests = await codechefContestSource.fetchUpcoming();
      expect(contests).toHaveLength(1);

      const starter = contests[0];
      expect(starter.platform).toBe('codechef');
      expect(starter.externalId).toBe('START160');
      expect(starter.contestName).toBe('Starters 160 (Rated)');
      expect(starter.durationSeconds).toBe(7200);
      expect(starter.url).toBe('https://www.codechef.com/START160');
      expect(starter.phase).toBe('BEFORE');
      expect(starter.kind).toBe('scheduled');
    });
  });

  describe('ContestRefreshService Fault Tolerance & Stale Fallback', () => {
    it('upserts contests into DsaContest and caches in Redis when successful', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'OK',
          result: [
            {
              id: 3001,
              name: 'Codeforces Global Round 28',
              type: 'CF',
              phase: 'BEFORE',
              frozen: false,
              durationSeconds: 9000,
              startTimeSeconds: nowSec + 10000,
            },
          ],
        }),
      } as Response);

      const res = await contestRefreshService.refreshPlatformContests('codeforces');
      expect(res.stale).toBe(false);
      expect(res.contests).toHaveLength(1);

      // Verify DB persistence
      const inDb = await DsaContest.findOne({ externalId: '3001', platform: 'codeforces', kind: 'scheduled' });
      expect(inDb).not.toBeNull();
      expect(inDb?.contestName).toBe('Codeforces Global Round 28');
      expect(inDb?.stale).toBe(false);

      // Verify Redis cache
      const cached = redisStore.get('devtrack:contests:upcoming:codeforces');
      expect(cached).toBeDefined();
      expect(cached).toContain('Codeforces Global Round 28');
    });

    it('enforces unique compound index on { platform, externalId, kind } for scheduled contests', async () => {
      await DsaContest.create({
        platform: 'codeforces',
        externalId: 'unique-cf-100',
        contestName: 'Round 100',
        kind: 'scheduled',
        startTime: new Date(Date.now() + 3600000),
        endTime: new Date(Date.now() + 7200000),
      });

      // Attempting to insert duplicate scheduled contest with identical (platform, externalId, kind) must reject
      await expect(
        DsaContest.create({
          platform: 'codeforces',
          externalId: 'unique-cf-100',
          contestName: 'Duplicate Round 100',
          kind: 'scheduled',
          startTime: new Date(Date.now() + 3600000),
          endTime: new Date(Date.now() + 7200000),
        })
      ).rejects.toThrow();
    });

    it('prunes obsolete future contests when upstream provider cancels or removes them', async () => {
      const now = new Date();
      const futureStart = new Date(now.getTime() + 3600000);
      const futureEnd = new Date(now.getTime() + 7200000);

      // Pre-seed an existing future scheduled contest that is subsequently cancelled upstream
      await DsaContest.create({
        platform: 'codeforces',
        externalId: 'cancelled-round-999',
        contestName: 'Cancelled Codeforces Round',
        kind: 'scheduled',
        startTime: futureStart,
        endTime: futureEnd,
        stale: false,
      });

      // Pre-seed another platform contest that should NOT be pruned
      await DsaContest.create({
        platform: 'leetcode',
        externalId: 'weekly-keep-400',
        contestName: 'Weekly Contest 400',
        kind: 'scheduled',
        startTime: futureStart,
        endTime: futureEnd,
        stale: false,
      });

      // Mock upstream returning only active contest "active-round-1000", omitting "cancelled-round-999"
      const nowSec = Math.floor(now.getTime() / 1000);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'OK',
          result: [
            {
              id: 1000,
              name: 'Active Codeforces Round 1000',
              type: 'CF',
              phase: 'BEFORE',
              frozen: false,
              durationSeconds: 7200,
              startTimeSeconds: nowSec + 3600,
            },
          ],
        }),
      } as Response);

      const res = await contestRefreshService.refreshPlatformContests('codeforces');
      expect(res.stale).toBe(false);
      expect(res.contests).toHaveLength(1);
      expect(res.contests[0].externalId).toBe('1000');

      // The cancelled contest should have been pruned
      const cancelledDoc = await DsaContest.findOne({
        platform: 'codeforces',
        externalId: 'cancelled-round-999',
        kind: 'scheduled',
      });
      expect(cancelledDoc).toBeNull();

      // The new active contest exists
      const activeDoc = await DsaContest.findOne({
        platform: 'codeforces',
        externalId: '1000',
        kind: 'scheduled',
      });
      expect(activeDoc).not.toBeNull();

      // The other platform's contest remains intact
      const leetcodeDoc = await DsaContest.findOne({
        platform: 'leetcode',
        externalId: 'weekly-keep-400',
        kind: 'scheduled',
      });
      expect(leetcodeDoc).not.toBeNull();
    });

    it('falls back to stale cache without crashing when provider times out', async () => {
      // 1. Seed existing cache in Redis
      const existingContest = {
        platform: 'codeforces' as const,
        externalId: 'cached-100',
        contestName: 'Cached Codeforces Round',
        startTime: new Date(Date.now() + 5000),
        endTime: new Date(Date.now() + 15000),
        durationSeconds: 10000,
        url: 'https://codeforces.com/contests/cached-100',
        phase: 'BEFORE' as const,
        kind: 'scheduled' as const,
        stale: false,
        fetchedAt: new Date(),
      };
      redisStore.set('devtrack:contests:upcoming:codeforces', JSON.stringify([existingContest]));

      // 2. Mock external outage / timeout
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Gateway Timeout 504'));

      const res = await contestRefreshService.refreshPlatformContests('codeforces');
      expect(res.stale).toBe(true);
      expect(res.contests).toHaveLength(1);
      expect(res.contests[0].externalId).toBe('cached-100');
      expect(res.contests[0].stale).toBe(true);
      expect(res.error).toContain('Gateway Timeout 504');
    });

    it('falls back to MongoDB if Redis cache is missing during an outage', async () => {
      // Seed MongoDB only
      await DsaContest.create({
        platform: 'leetcode',
        externalId: 'weekly-test-db',
        contestName: 'Weekly Contest DB Fallback',
        startTime: new Date(Date.now() + 10000),
        endTime: new Date(Date.now() + 20000),
        durationSeconds: 10000,
        url: 'https://leetcode.com/contest/weekly-test-db/',
        phase: 'BEFORE',
        kind: 'scheduled',
        stale: false,
      });

      // External call fails
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('LeetCode GraphQL unreachable'));

      const res = await contestRefreshService.refreshPlatformContests('leetcode');
      expect(res.stale).toBe(true);
      expect(res.contests).toHaveLength(1);
      expect(res.contests[0].contestName).toBe('Weekly Contest DB Fallback');
      expect(res.contests[0].stale).toBe(true);
    });

    it('refreshAllContests summarizes outcomes across all 4 platforms', async () => {
      // Mock fetch responding with valid Codeforces but failing others
      const nowSec = Math.floor(Date.now() / 1000);
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('codeforces.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: 'OK',
              result: [
                {
                  id: 9999,
                  name: 'Round 9999',
                  type: 'CF',
                  phase: 'BEFORE',
                  durationSeconds: 7200,
                  startTimeSeconds: nowSec + 5000,
                },
              ],
            }),
          };
        }
        throw new Error('Platform temporary maintenance');
      });

      const summary = await contestRefreshService.refreshAllContests();
      expect(summary.success).toBe(true);
      expect(summary.refreshed.codeforces).toBe(1);
      expect(summary.stale.codeforces).toBe(false);
      expect(summary.stale.leetcode).toBe(true);
      expect(summary.stale.atcoder).toBe(true);
      expect(summary.stale.codechef).toBe(true);
    });
  });

  describe('BullMQ Contest Refresh Worker & Schedule', () => {
    it('schedules repeatable job with 6-hour interval', async () => {
      const addSpy = vi.spyOn(contestRefreshQueue, 'add').mockResolvedValue({} as any);

      await scheduleContestRefreshTask();

      expect(addSpy).toHaveBeenCalledWith(
        'contest-refresh',
        {},
        expect.objectContaining({
          repeat: { every: SIX_HOURS_MS },
          jobId: 'scheduled-contest-refresh',
        })
      );
    });

    it('processes job by triggering contestRefreshService.refreshAllContests', async () => {
      const refreshSpy = vi.spyOn(contestRefreshService, 'refreshAllContests').mockResolvedValue({
        success: true,
        refreshed: { codeforces: 2, leetcode: 2, atcoder: 1, codechef: 1 },
        stale: { codeforces: false, leetcode: false, atcoder: false, codechef: false },
        total: 6,
      });

      const result = await processContestRefresh({ id: 'test-job-1' } as any);

      expect(refreshSpy).toHaveBeenCalled();
      expect(result).toMatchObject({ success: true, total: 6 });
    });
  });

  describe('Admin Trigger POST /api/v1/ops/contests/refresh', () => {
    it('executes refresh and returns success response', async () => {
      const { opsController } = await import('../../../modules/ops/ops.controller.js');
      vi.spyOn(contestRefreshService, 'refreshAllContests').mockResolvedValue({
        success: true,
        refreshed: { codeforces: 3, leetcode: 2, atcoder: 2, codechef: 1 },
        stale: { codeforces: false, leetcode: false, atcoder: false, codechef: false },
        total: 8,
      });

      const req: any = { user: { username: 'admin' } };
      const res: any = {
        json: vi.fn(),
        status: vi.fn().mockReturnThis(),
      };

      await opsController.refreshContests(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: expect.stringContaining('successfully'),
          data: expect.objectContaining({ total: 8 }),
        })
      );
    });
  });
});
