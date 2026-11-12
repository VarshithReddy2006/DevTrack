// src/shared/syncScheduler.ts — Platform sync scheduler
// Schedules background sync via BullMQ. Reuses existing sync service logic.
// Extracted for clean separation — scheduler is now purely orchestration.

import cron from 'node-cron';
import { Types } from 'mongoose';
import { ConnectedPlatform } from '../db/models/index.js';
import { syncState } from './syncState.js';
import { getPlatformSyncQueue } from './jobs/index.js';
import { PlatformSyncJobData, QueueNames } from './jobs/types.js';
import { logger } from './logger.js';
import { env } from '../config/env.js';
import { acquireSchedulerLock, releaseSchedulerLock } from './redis/syncLock.service.js';

// ---------------------------------------------------------------------------
// Distributed leader lock + In-memory guard — prevents overlapping cron executions
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

    const queue = getPlatformSyncQueue();
    const enqueuedJobs: string[] = [];

    for (const [userId, platformNames] of userPlatformMap) {
      for (const platformName of platformNames) {
        const jobData: PlatformSyncJobData = {
          userId,
          platformName,
          requestId: jobId,
        };

        await queue.add(
          `sync-${platformName}-${userId}-${Date.now()}`,
          jobData,
          {
            jobId: `sync-${platformName}-${userId}-${Date.now()}`,
          }
        );

        enqueuedJobs.push(`${userId}:${platformName}`);
        logger.info('[sync-scheduler] Job enqueued', {
          event: 'job_enqueued',
          queue: QueueNames.PLATFORM_SYNC,
          jobId: `sync-${platformName}-${userId}-${Date.now()}`,
          userId,
          platform: platformName,
          requestId: jobId,
        });
      }
    }

    logger.info('[sync-scheduler] Scheduled sync complete', {
      job: 'platform-sync',
      jobId,
      jobsEnqueued: enqueuedJobs.length,
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

// ---------------------------------------------------------------------------
// Scheduler lifecycle
// ---------------------------------------------------------------------------

let scheduledTask: cron.ScheduledTask | null = null;
let isStarted = false;

export function startSyncScheduler(): void {
  if (isStarted) return;

  if (!env.SYNC_ENABLED) {
    logger.info('[sync-scheduler] Disabled via SYNC_ENABLED=false', {
      job: 'platform-sync',
    });
    return;
  }

  const intervalMinutes = env.SYNC_INTERVAL_MINUTES;
  const cronExpression = `*/${intervalMinutes} * * * *`;

  scheduledTask = cron.schedule(cronExpression, () => {
    void runScheduledSync();
  });

  isStarted = true;

  logger.info('[sync-scheduler] Started', {
    job: 'platform-sync',
    intervalMinutes,
    cooldownMs: env.SYNC_COOLDOWN_MS,
    env: env.NODE_ENV,
  });

  // Run an initial sync shortly after startup
  setTimeout(() => {
    void runScheduledSync();
  }, 10_000);
}

export function stopSyncScheduler(): void {
  if (!isStarted || !scheduledTask) return;

  scheduledTask.stop();
  scheduledTask = null;
  isStarted = false;

  logger.info('[sync-scheduler] Stopped', { job: 'platform-sync' });
}

export function isSchedulerRunning(): boolean {
  return isStarted;
}