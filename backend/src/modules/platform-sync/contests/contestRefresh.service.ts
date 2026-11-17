import { getRedisClient, isRedisConfigured } from '../../../shared/redis/client.js';
import { logger } from '../../../shared/logger.js';
import { DsaContest } from '../../../db/models/dsaContest.model.js';
import type { ContestPlatform, ContestSource, UpcomingContest } from './ContestSource.js';
import { codeforcesContestSource } from './codeforcesContestSource.js';
import { leetcodeContestSource } from './leetcodeContestSource.js';
import { atcoderContestSource } from './atcoderContestSource.js';
import { codechefContestSource } from './codechefContestSource.js';

export const CONTEST_CACHE_TTL_SECONDS = 6 * 3600; // 6 hours

export interface PlatformRefreshResult {
  platform: ContestPlatform;
  contests: UpcomingContest[];
  stale: boolean;
  error?: string;
}

export interface RefreshSummary {
  success: boolean;
  refreshed: Record<ContestPlatform, number>;
  stale: Record<ContestPlatform, boolean>;
  total: number;
}

export class ContestRefreshService {
  private sources: Map<ContestPlatform, ContestSource> = new Map();

  constructor() {
    this.registerSource(codeforcesContestSource);
    this.registerSource(leetcodeContestSource);
    this.registerSource(atcoderContestSource);
    this.registerSource(codechefContestSource);
  }

  registerSource(source: ContestSource): void {
    this.sources.set(source.platform, source);
  }

  getSource(platform: ContestPlatform): ContestSource | undefined {
    return this.sources.get(platform);
  }

  getCacheKey(platform: ContestPlatform): string {
    return `devtrack:contests:upcoming:${platform}`;
  }

  async refreshPlatformContests(
    platform: ContestPlatform,
    signal?: AbortSignal
  ): Promise<PlatformRefreshResult> {
    const source = this.sources.get(platform);
    if (!source) {
      throw new Error(`Contest source for platform "${platform}" not found`);
    }

    const cacheKey = this.getCacheKey(platform);
    const redis = isRedisConfigured() ? getRedisClient() : null;

    try {
      const fetched = await source.fetchUpcoming(signal);
      const now = new Date();

      // Upsert into DsaContest
      for (const contest of fetched) {
        await DsaContest.updateOne(
          {
            platform: contest.platform,
            externalId: contest.externalId,
            kind: 'scheduled',
          },
          {
            $set: {
              platform: contest.platform,
              externalId: contest.externalId,
              contestName: contest.contestName,
              startTime: contest.startTime,
              endTime: contest.endTime,
              durationSeconds: contest.durationSeconds,
              url: contest.url,
              phase: contest.phase,
              kind: 'scheduled',
              stale: false,
              fetchedAt: now,
            },
          },
          { upsert: true }
        );
      }

      // Prune obsolete scheduled contests for this platform that are no longer returned upstream
      const activeExternalIds = fetched
        .map((c) => c.externalId)
        .filter((id): id is string => Boolean(id));

      await DsaContest.deleteMany({
        platform,
        kind: 'scheduled',
        endTime: { $gte: now },
        externalId: { $nin: activeExternalIds },
      });
      if (redis && redis.status === 'ready') {
        try {
          await redis.set(cacheKey, JSON.stringify(fetched), 'EX', CONTEST_CACHE_TTL_SECONDS);
        } catch (cacheErr) {
          logger.warn(`[contest-refresh] Failed writing Redis cache for ${platform}`, {
            error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
          });
        }
      }

      return { platform, contests: fetched, stale: false };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[contest-refresh] Platform ${platform} fetch failed: ${errorMsg}. Falling back to cached data.`);

      // 1. Attempt fallback to Redis cache
      if (redis && redis.status === 'ready') {
        try {
          const cachedJson = await redis.get(cacheKey);
          if (cachedJson) {
            const parsed = JSON.parse(cachedJson) as UpcomingContest[];
            const staleContests: UpcomingContest[] = parsed.map((c) => ({
              ...c,
              startTime: new Date(c.startTime),
              endTime: new Date(c.endTime),
              fetchedAt: c.fetchedAt ? new Date(c.fetchedAt) : undefined,
              stale: true,
            }));
            return { platform, contests: staleContests, stale: true, error: errorMsg };
          }
        } catch (cacheErr) {
          logger.warn(`[contest-refresh] Failed reading Redis fallback for ${platform}`, {
            error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
          });
        }
      }

      // 2. Fallback to MongoDB persistence
      try {
        const dbContests = await DsaContest.find({
          platform,
          kind: 'scheduled',
          endTime: { $gte: new Date() },
        })
          .sort({ startTime: 1 })
          .lean();

        const staleContests: UpcomingContest[] = dbContests.map((doc) => ({
          platform: doc.platform as ContestPlatform,
          externalId: doc.externalId || doc.id || doc.contestName,
          contestName: doc.contestName,
          startTime: doc.startTime || new Date(),
          endTime: doc.endTime || new Date(),
          durationSeconds: doc.durationSeconds || 0,
          url: doc.url || '',
          phase: (doc.phase as any) || 'BEFORE',
          kind: 'scheduled',
          stale: true,
          fetchedAt: doc.fetchedAt,
        }));

        return { platform, contests: staleContests, stale: true, error: errorMsg };
      } catch (dbErr) {
        logger.error(`[contest-refresh] MongoDB fallback failed for ${platform}`, dbErr);
        return { platform, contests: [], stale: true, error: errorMsg };
      }
    }
  }

  async refreshAllContests(signal?: AbortSignal): Promise<RefreshSummary> {
    const platforms: ContestPlatform[] = ['codeforces', 'leetcode', 'atcoder', 'codechef'];
    const results = await Promise.allSettled(
      platforms.map((platform) => this.refreshPlatformContests(platform, signal))
    );

    const refreshed: Record<ContestPlatform, number> = {
      codeforces: 0,
      leetcode: 0,
      atcoder: 0,
      codechef: 0,
    };
    const stale: Record<ContestPlatform, boolean> = {
      codeforces: false,
      leetcode: false,
      atcoder: false,
      codechef: false,
    };

    let total = 0;
    let anySuccess = false;

    for (let i = 0; i < platforms.length; i++) {
      const p = platforms[i];
      const res = results[i];

      if (res.status === 'fulfilled') {
        const item = res.value;
        refreshed[p] = item.contests.length;
        stale[p] = item.stale;
        total += item.contests.length;
        if (!item.stale) anySuccess = true;
      } else {
        stale[p] = true;
        refreshed[p] = 0;
      }
    }

    return {
      success: anySuccess,
      refreshed,
      stale,
      total,
    };
  }

  async getUpcomingContests(
    platform?: ContestPlatform,
    forceRefresh = false
  ): Promise<UpcomingContest[]> {
    const platforms: ContestPlatform[] = platform
      ? [platform]
      : ['codeforces', 'leetcode', 'atcoder', 'codechef'];

    if (forceRefresh) {
      const results = await Promise.all(
        platforms.map((p) => this.refreshPlatformContests(p))
      );
      const all = results.flatMap((r) => r.contests);
      all.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      return all;
    }

    const redis = isRedisConfigured() ? getRedisClient() : null;
    const allContests: UpcomingContest[] = [];

    for (const p of platforms) {
      let loaded = false;
      if (redis && redis.status === 'ready') {
        try {
          const cached = await redis.get(this.getCacheKey(p));
          if (cached) {
            const list = JSON.parse(cached) as UpcomingContest[];
            for (const item of list) {
              allContests.push({
                ...item,
                startTime: new Date(item.startTime),
                endTime: new Date(item.endTime),
                fetchedAt: item.fetchedAt ? new Date(item.fetchedAt) : undefined,
              });
            }
            loaded = true;
          }
        } catch {
          // Ignore cache read error, fall through to DB
        }
      }

      if (!loaded) {
        // Query DB
        const docs = await DsaContest.find({
          platform: p,
          kind: 'scheduled',
          endTime: { $gte: new Date() },
        })
          .sort({ startTime: 1 })
          .lean();

        if (docs.length > 0) {
          for (const doc of docs) {
            allContests.push({
              platform: doc.platform as ContestPlatform,
              externalId: doc.externalId || doc.id || doc.contestName,
              contestName: doc.contestName,
              startTime: doc.startTime || new Date(),
              endTime: doc.endTime || new Date(),
              durationSeconds: doc.durationSeconds || 0,
              url: doc.url || '',
              phase: (doc.phase as any) || 'BEFORE',
              kind: 'scheduled',
              stale: doc.stale ?? false,
              fetchedAt: doc.fetchedAt,
            });
          }
        } else {
          // Nothing in DB, trigger single platform refresh
          const res = await this.refreshPlatformContests(p);
          allContests.push(...res.contests);
        }
      }
    }

    allContests.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    return allContests;
  }
}

export const contestRefreshService = new ContestRefreshService();
