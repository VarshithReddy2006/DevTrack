// src/shared/syncScheduler.ts — Platform sync sweep
// Enqueues one platform-sync job per connected platform. The recurring trigger is a BullMQ
// repeatable (see shared/jobs/maintenanceWorker.ts), so exactly one instance runs each tick.

import { Types } from 'mongoose';
import { ConnectedPlatform } from '../db/models/index.js';
import { syncState } from './syncState.js';
import { getPlatformSyncQueue } from './jobs/index.js';
import { JobRetryConfig, PlatformSyncJobData, QueueNames } from './jobs/types.js';
import { logger } from './logger.js';
import { env } from '../config/env.js';
import { acquireSchedulerLock, releaseSchedulerLock } from './redis/syncLock.service.js';

// ---------------------------------------------------------------------------
// Distributed leader lock + In-memory guard — prevents overlapping sweeps
// ---------------------------------------------------------------------------

let syncLock = false;

async function acquireLock(): Promise<boolean> {
  if (syncLock) {
    logger.warn('[sync-scheduler] Skipped: sync already in progress locally', {
      job: 'platform-sync',
      reason: 'overlapping_execution',
    });
    return false;
  }
  const leaderAcquired = await acquireSchedulerLock(60_000);
  if (!leaderAcquired) {
    logger.info('[sync-scheduler] Skipped: another replica holds scheduler lock', {
      job: 'platform-sync',
      reason: 'leader_lock_held',
    });
    return false;
  }
  syncLock = true;
  return true;
}

async function releaseLock(): Promise<void> {
  syncLock = false;
  await releaseSchedulerLock();
}

// ---------------------------------------------------------------------------
// Job building
// ---------------------------------------------------------------------------

/** Jobs sent to Redis in one addBulk pipeline. */
export const SYNC_BULK_CHUNK_SIZE = 500;

/** Spreads retries out so a platform outage is not followed by every job retrying at once. */
const RETRY_JITTER = 0.5;

/** Index of the sync window containing `now`. A window is as long as the sweep interval. */
function syncWindow(now: number): number {
  return Math.floor(now / (env.SYNC_INTERVAL_MINUTES * 60_000));
}

function buildSyncJob(userId: string, platformName: string, window: number, requestId: string) {
  const key = `sync-${platformName}-${userId}`;
  const data: PlatformSyncJobData = { userId, platformName, requestId };
  return {
    name: key,
    data,
    opts: {
      // One job per user and platform per window. BullMQ forbids ':' in custom ids.
      jobId: `${key}-${window}`,
      // Also hold back later windows while an earlier job is still waiting, delayed or active.
      deduplication: { id: key },
      attempts: JobRetryConfig.platformSync.attempts,
      backoff: { ...JobRetryConfig.platformSync.backoff, jitter: RETRY_JITTER },
    },
  };
}

// ---------------------------------------------------------------------------
// Sync runner — enqueues sync jobs, does not execute inline
// ---------------------------------------------------------------------------

async function runScheduledSync(): Promise<void> {
  const acquired = await acquireLock();
  if (!acquired) return;

  const startTime = Date.now();
  syncState.beginSync();
  const jobId = `sync-${Date.now()}`;

  logger.info('[sync-scheduler] Scheduled sync started', {
    job: 'platform-sync',
    jobId,
    intervalMinutes: env.SYNC_INTERVAL_MINUTES,
    env: env.NODE_ENV,
  });

  try {
    const platforms = await ConnectedPlatform.find({
      isConnected: true,
    }).lean();

    if (platforms.length === 0) {
      logger.info('[sync-scheduler] No connected platforms found', {
        job: 'platform-sync',
        jobId,
        durationMs: Date.now() - startTime,
      });
      syncState.completeSync('success', Date.now() - startTime);
      return;
    }

    // Group by userId — one sync per user (avoids duplicate work)
    const userPlatformMap = new Map<string, string[]>();
    for (const platform of platforms) {
      const userId = platform.userId.toString();
      if (!userPlatformMap.has(userId)) {
        userPlatformMap.set(userId, []);
      }
      userPlatformMap.get(userId)!.push(platform.platformName);
    }

    const totalUsers = userPlatformMap.size;

    logger.info('[sync-scheduler] Users to sync', {
      job: 'platform-sync',
      jobId,
      userCount: totalUsers,
      platformCount: platforms.length,
    });

    const window = syncWindow(startTime);
    const jobs = [...userPlatformMap].flatMap(([userId, platformNames]) =>
      [...new Set(platformNames)].map((platformName) => buildSyncJob(userId, platformName, window, jobId))
    );

    const queue = getPlatformSyncQueue();
    let heldByEarlierJob = 0;

    for (let offset = 0; offset < jobs.length; offset += SYNC_BULK_CHUNK_SIZE) {
      const chunk = jobs.slice(offset, offset + SYNC_BULK_CHUNK_SIZE);
      const added = await queue.addBulk(chunk);
      // When an unfinished job holds the deduplication key, BullMQ answers with that job's id.
      // A repeat within the same window answers with the requested id, so it is not counted here.
      heldByEarlierJob += added.filter((job, i) => job.id !== chunk[i].opts.jobId).length;
      logger.debug('[sync-scheduler] Batch enqueued', {
        event: 'jobs_enqueued',
        queue: QueueNames.PLATFORM_SYNC,
        batchSize: chunk.length,
        requestId: jobId,
      });
    }

    logger.info('[sync-scheduler] Scheduled sync complete', {
      job: 'platform-sync',
      jobId,
      jobsSubmitted: jobs.length,
      jobsHeldByEarlierJob: heldByEarlierJob,
      durationMs: Date.now() - startTime,
    });

    syncState.completeSync('success', Date.now() - startTime);
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error('[sync-scheduler] Scheduled sync fatal error', {
      job: 'platform-sync',
      jobId,
      error: err instanceof Error ? err.message : String(err),
      durationMs,
    });
    syncState.completeSync('failed', durationMs);
  } finally {
    await releaseLock();
  }
}

export { runScheduledSync };
