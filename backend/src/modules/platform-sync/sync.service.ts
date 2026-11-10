import { Types } from 'mongoose';
import { ConnectedPlatform, PlatformStats, SyncJob } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { createActivity, incrementDailyActivity } from '../activity/activity.service.js';
import { eventBus } from '../../shared/sse/index.js';
import { acquireSyncLockWithRetry, releaseSyncLock } from '../../shared/redis/syncLock.service.js';
import { getReadinessDsaQueue } from '../../shared/jobs/queueFactory.js';
import { getAdapter } from './adapters/index.js';
import type { FetchedPlatformStats } from './adapters/types.js';
import { persistSubmissions, persistContests, updatePlatformTopicAnalytics, generateSyncActivityEvents } from './sync.persistence.js';

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
    const result = await syncPlatformWithLock(userId, platformName);
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
  const platform = await ConnectedPlatform.findOne({ userId: new Types.ObjectId(userId), platformName, isConnected: true });

  if (!platform) {
    return { platform: platformName, success: false, error: 'Platform not connected' };
  }

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

  await ConnectedPlatform.updateOne({ _id: platform._id }, { syncStatus: 'syncing', syncError: null });
  const job = await SyncJob.create({
    userId: new Types.ObjectId(userId),
    platformName: platformName as 'leetcode' | 'codeforces' | 'github' | 'codechef',
    status: 'running',
  });

  try {
    eventBus.emitSyncStarted(userId, platformName);
    const adapter = getAdapter(platformName);
    const result = await adapter.sync(platform.username);
    if (!result.success) throw new Error(result.error || 'Platform adapter sync failed');
    const fetched: FetchedPlatformStats = {
      username: platform.username, totalSolved: result.stats.totalSolved,
      easySolved: result.stats.easySolved, mediumSolved: result.stats.mediumSolved,
      hardSolved: result.stats.hardSolved, rating: result.stats.rating ?? null,
      rank: result.stats.rank ?? null, totalContests: result.stats.totalContests ?? 0,
      rawData: result.stats.rawData ?? {},
    };

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

    try {
      await incrementDailyActivity(userId, new Date(), 'sync');
    } catch (actErr) {
    }

    if (platformName !== 'github') {
      try {
        await persistSubmissions(userId, result.submissions);
        await persistContests(userId, platformName, result.contests ?? []);
        await updatePlatformTopicAnalytics(userId, platformName, fetched);
        await generateSyncActivityEvents(userId, platformName, fetched);
      } catch (ingestionErr) {
        logger.warn(`DSA ingestion failed for ${platformName} (non-fatal)`, {
          error: ingestionErr instanceof Error ? ingestionErr.message : String(ingestionErr),
        });
      }
    }

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

    eventBus.emitSyncFailed(userId, platformName, errorMessage);

    return { platform: platformName, success: false, error: errorMessage };
  }
}

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

export async function ingestLeetCodeSubmissions(userId: string, username: string): Promise<number> {
  return persistSubmissions(userId, await getAdapter('leetcode').fetchSubmissions(username));
}
export async function ingestLeetCodeContests(userId: string, fetched: FetchedPlatformStats): Promise<number> {
  const adapter = getAdapter('leetcode');
  return persistContests(userId, 'leetcode', await adapter.fetchContests!(fetched.username,
    { ...fetched, platform: 'leetcode', fetchedAt: new Date() }));
}
