import { scheduleQuestGeneration } from '../../modules/quests/questScheduler.js';
import { scheduleQuestExpiration } from '../../modules/quests/questExpiration.worker.js';
// src/shared/jobs/maintenanceWorker.ts — Periodic maintenance worker
// Runs DLQ cleanup, prunes expired SSE resources, and performs Redis hygiene.
// Designed to run on a cron schedule via BullMQ repeatable jobs.

import { Worker, Job, Queue } from 'bullmq';
import { getRedisClient, withDistributedLock } from '../redis/index.js';
import { logger } from '../logger.js';
import { getQueueTelemetry } from '../tracing/queueTelemetry.js';
import { createDlqWorker, dlqService, DLQ_QUEUE_NAMES } from './dlq.service.js';
import { QueueNames, SystemMaintenanceJobData } from './types.js';
import { runScheduledMissionSweep } from '../scheduler/missionScheduler.js';
import { runScheduledSync } from '../syncScheduler.js';
import { env } from '../../config/env.js';
import { cleanupStaleLocks } from '../redis/syncLock.service.js';
import { User, UserAnalytics, UserStreakLog } from '../../db/models/index.js';
import { focusEngine } from '../../modules/activity/focusEngine.service.js';
import { AntiGamingWorker } from '../../modules/profile/antiGaming.worker.js';
import { getNotificationQueue } from './queueFactory.js';
import { seedDailyChallengeWindow } from '../../modules/daily-challenge/daily-challenge.service.js';
import { localDateString, localDayBounds, resolveTimezone } from '../../modules/daily-challenge/daily-challenge.time.js';

let _worker: Worker<SystemMaintenanceJobData> | null = null;
let _queue: Queue<SystemMaintenanceJobData> | null = null;

// ---------------------------------------------------------------------------
// Maintenance tasks
// ---------------------------------------------------------------------------

async function runCleanupFailedJobs(): Promise<void> {
  logger.info('[maintenance] Running DLQ cleanup');
  try {
    let totalCleaned = 0;
    // Clean DLQ entries for all known queue types
    const queues = DLQ_QUEUE_NAMES;
    for (const q of queues) {
      try {
        const cleaned = await dlqService.cleanupDlq(q);
        totalCleaned += cleaned;
      } catch (err) {
        logger.warn('[maintenance] Individual queue DLQ cleanup failed', { queue: q, error: err instanceof Error ? err.message : String(err) });
      }
    }
    logger.info('[maintenance] DLQ cleanup completed', { totalCleaned });
  } catch (err) {
    logger.error('[maintenance] DLQ cleanup failed', err);
  }
}

async function runPruneOldEvents(): Promise<void> {
  logger.info('[maintenance] Pruning expired SSE streams and sequences');
  const redis = getRedisClient();

  try {
    // Scan for orphaned sse:stream:* keys older than 10 minutes
    let cursor = '0';
    let pruned = 0;
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'sse:stream:*', 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const ttl = await redis.ttl(key);
        // If a key somehow lost its TTL, set one
        if (ttl === -1) {
          await redis.expire(key, 600); // 10 min safety net
          pruned++;
        }
      }
    } while (cursor !== '0');

    // Same for sse:seq:* keys
    cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'sse:seq:*', 'COUNT', 100);
      cursor = nextCursor;
      for (const key of keys) {
        const ttl = await redis.ttl(key);
        if (ttl === -1) {
          await redis.expire(key, 300);
          pruned++;
        }
      }
    } while (cursor !== '0');

    // Trim the global event stream
    const trimmed = await redis.xtrim('devtrack:events:stream', 'MAXLEN', '~', 50000);

    logger.info('[maintenance] Prune completed', { pruned, streamTrimmed: trimmed });
  } catch (err) {
    logger.error('[maintenance] Prune failed', err);
  }
}

async function runHealthCheck(): Promise<void> {
  logger.info('[maintenance] Running Redis health check');
  const redis = getRedisClient();

  try {
    const start = Date.now();
    await redis.ping();
    const latencyMs = Date.now() - start;

    const info = await redis.info('memory');
    const usedMemoryMatch = info.match(/used_memory_human:([^\r\n]+)/);

    logger.info('[maintenance] Health check passed', {
      redisLatencyMs: latencyMs,
      redisMemory: usedMemoryMatch?.[1]?.trim() ?? 'unknown',
    });
  } catch (err) {
    logger.error('[maintenance] Health check failed', err);
  }
}

async function runGenerateDailyMissions(): Promise<void> {
  logger.info('[maintenance] Generating daily missions');
  try {
    await runScheduledMissionSweep('daily');
    logger.info('[maintenance] Daily missions generated successfully');
  } catch (err) {
    logger.error('[maintenance] Daily mission generation failed', err);
  }
}

async function runGenerateWeeklyMissions(): Promise<void> {
  logger.info('[maintenance] Generating weekly missions');
  try {
    await runScheduledMissionSweep('weekly');
    logger.info('[maintenance] Weekly missions generated successfully');
  } catch (err) {
    logger.error('[maintenance] Weekly mission generation failed', err);
  }
}

async function runCleanupStaleSyncLocks(): Promise<void> {
  logger.info('[maintenance] Cleaning up stale sync locks');
  try {
    const cleaned = await cleanupStaleLocks();
    logger.info('[maintenance] Stale sync lock cleanup completed', { cleaned });
  } catch (err) {
    logger.error('[maintenance] Stale sync lock cleanup failed', err);
  }
}

const HOUR_MS = 60 * 60 * 1000;

export async function runStreakAtRiskCheck(): Promise<void> {
  logger.info('[maintenance] Running streak at risk check');
  const now = new Date();
  const windows = new Map<string, { today: Date; yesterday: Date; withinWindow: boolean }>();
  let enqueueRequests = 0;

  const candidates = UserAnalytics.find({ currentStreak: { $gt: 0 } })
    .select('userId currentStreak streakFreezeUntil').lean().cursor();
  for await (const candidate of candidates) {
    try {
      const user = await User.findById(candidate.userId).select('timezone').lean();
      if (!user) continue;

      const timezone = resolveTimezone(user.timezone);
      let window = windows.get(timezone);
      if (!window) {
        const dateKey = localDateString(now, timezone);
        const { end } = localDayBounds(dateKey, timezone);
        // Streak logs store the local calendar date at UTC midnight.
        const today = new Date(`${dateKey}T00:00:00.000Z`);
        // Previous local calendar date as UTC midnight, to match log storage format
        // Parse today's date key and decrement day (handles month/year boundaries)
        const [year, month, day] = dateKey.split('-').map(Number);
        const prevDate = new Date(Date.UTC(year, month - 1, day - 1));
        const yesterday = new Date(prevDate.toISOString().slice(0, 10) + 'T00:00:00.000Z');
        window = {
          today,
          yesterday,
          withinWindow: end.getTime() - now.getTime() <= 6 * HOUR_MS,
        };
        windows.set(timezone, window);
      }
      if (!window.withinWindow) continue;

      const freezeActive = candidate.streakFreezeUntil && candidate.streakFreezeUntil >= now;
      // When freeze is active, look for logs from 2 local days ago
      // Calculate as two decrements of the date key (to handle month/year boundaries correctly)
      const oldestActiveDay = freezeActive
        ? (() => {
          const [year, month, day] = window.yesterday.toISOString().slice(0, 10).split('-').map(Number);
          return new Date(Date.UTC(year, month - 1, day - 1));
        })()
        : window.yesterday;
      const lastLog = await UserStreakLog.findOne({
        userId: candidate.userId,
        date: { $gte: oldestActiveDay, $lte: window.today },
        activityCount: { $gt: 0 },
      }).sort({ date: -1 }).select('date').lean();
      if (!lastLog || lastLog.date.getTime() === window.today.getTime()) continue;

      const userId = candidate.userId.toString();
      const dateKey = window.today.toISOString().slice(0, 10);
      const id = `streak-risk-${userId}-${dateKey}`;
      await getNotificationQueue().add('streak-at-risk', {
        type: 'streak_at_risk',
        userId,
        data: { currentStreak: candidate.currentStreak },
      }, {
        jobId: id,
        // Keep deduplication even if queue retention removes the completed job.
        deduplication: { id, ttl: 72 * HOUR_MS },
      });
      enqueueRequests++;
    } catch (err) {
      logger.warn('[maintenance] Failed to check streak reminder eligibility', {
        userId: candidate.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('[maintenance] Streak at risk check completed', { enqueueRequests });
}

export async function runCheckContestStartingSoon(): Promise<number> {
  logger.info('[maintenance] Checking for contests starting in 30 minutes');
  const now = Date.now();
  const windowStart = new Date(now + 29 * 60 * 1000);
  const windowEnd = new Date(now + 31 * 60 * 1000);

  const { DsaContest } = await import('../../db/models/dsaContest.model.js');
  const { handleContestStartingSoon } = await import('../../modules/notifications/consumers/contestStartingSoon.consumer.js');

  const contests = await DsaContest.find({
    kind: 'scheduled',
    startTime: { $gte: windowStart, $lte: windowEnd },
    alertEmitted: { $ne: true },
  });

  let emitted = 0;
  const redis = getRedisClient();

  for (const contest of contests) {
    const contestId = contest._id.toString();
    const eventId = `contest:alert:${contestId}`;

    let lockAcquired = true;
    if (redis && redis.status === 'ready') {
      try {
        const acquired = await redis.set(`devtrack:alert:lock:${eventId}`, '1', 'EX', 86400, 'NX');
        if (!acquired) {
          lockAcquired = false;
        }
      } catch (err) {
        logger.warn('[maintenance] Redis lock failed for contest alert, proceeding with DB guard', { err });
      }
    }

    if (!lockAcquired) continue;

    await DsaContest.updateOne({ _id: contest._id }, { $set: { alertEmitted: true } });

    await handleContestStartingSoon({
      eventId,
      contestId,
      externalId: contest.externalId ?? undefined,
      contestName: contest.contestName,
      platform: contest.platform,
      startTime: contest.startTime ? contest.startTime.toISOString() : new Date().toISOString(),
      endTime: contest.endTime ? contest.endTime.toISOString() : undefined,
      durationSeconds: contest.durationSeconds ?? undefined,
      url: contest.url || `https://${contest.platform}.com`,
    });

    emitted++;
  }

  logger.info('[maintenance] Contest alert sweep completed', { emitted, contestsFound: contests.length });
  return emitted;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export function startMaintenanceWorker(): Worker<SystemMaintenanceJobData> {
  if (_worker) return _worker;

  const redis = getRedisClient();

  _worker = createDlqWorker<SystemMaintenanceJobData>(
    QueueNames.SYSTEM_MAINTENANCE,
    async (job: Job<SystemMaintenanceJobData>) => {
      const { task } = job.data;
      logger.info('[maintenance] Executing maintenance task', {
        event: 'maintenance_started',
        task,
        jobId: job.id,
      });

      switch (task) {
        case 'generate_quests':
          await withDistributedLock('generate_quests', async (lock) => {
            await (await import('../../modules/quests/questEngine.service.js')).runQuestGenerationSweep(new Date(), {
              shouldContinue: () => lock.isHeld,
            });
          }, { ttlMs: 60_000, autoRenew: true, renewIntervalMs: 30_000 });
          break;
        case 'expire_quests':
          await (await import('../../modules/quests/questExpiration.worker.js')).runQuestExpirationWorkerSweep();
          break;
        case 'cleanup_failed_jobs':
          await withDistributedLock('cleanup_failed_jobs', async () => {
            await runCleanupFailedJobs();
          }, { ttlMs: 5 * 60 * 1000 });
          break;
        case 'prune_old_events':
          await withDistributedLock('prune_old_events', async () => {
            await runPruneOldEvents();
          }, { ttlMs: 10 * 60 * 1000 });
          break;
        case 'health_check':
          await runHealthCheck();
          break;
        case 'generate_daily_missions':
          await runGenerateDailyMissions();
          break;
        case 'generate_weekly_missions':
          await runGenerateWeeklyMissions();
          break;
        case 'cleanup_stale_sync_locks':
          await withDistributedLock('cleanup_stale_sync_locks', async () => {
            await runCleanupStaleSyncLocks();
          }, { ttlMs: 2 * 60 * 1000 });
          break;
        case 'streak_at_risk_check':
          await withDistributedLock('streak_at_risk_check', async () => {
            await runStreakAtRiskCheck();
          }, { ttlMs: 5 * 60 * 1000 });
          break;
        case 'check_contest_starting_soon':
          await withDistributedLock('check_contest_starting_soon', async () => {
            await runCheckContestStartingSoon();
          }, { ttlMs: 2 * 60 * 1000 });
          break;
        case 'platform_sync_sweep':
          await runScheduledSync();
          break;
        case 'generate_daily_challenge':
          await seedDailyChallengeWindow();
          break;
        case 'audit_public_profiles':
          await AntiGamingWorker.startAuditJob(new Date(job.opts.prevMillis ?? job.timestamp));
          break;
        case 'reap_stale_focus_sessions':
          await focusEngine.reapStaleSessions();
          break;
        case 'data_export':
          if (job.data.userId) {
            const { generateAndNotifyDataExport } = await import('../../modules/privacy/dataExport.service.js');
            await generateAndNotifyDataExport(job.data.userId);
          }
          break;
        case 'account_erasure':
          if (job.data.userId) {
            const { executeAccountErasure } = await import('../../modules/privacy/accountErasure.worker.js');
            await executeAccountErasure(job.data.userId, job.data.options as any);
          }
          break;
        case 'submission_archive':
          await (await import('../../modules/dsa/submissionArchive.worker.js')).handleSubmissionArchiveJob();
          break;
        default:
          logger.warn('[maintenance] Unknown task type', { task });
      }
    },
    {
      connection: redis,
      concurrency: 1, // Maintenance is sequential
    }
  );

  _worker.on('error', (err) => {
    logger.error('[maintenance] Worker error', err);
  });

  logger.info('[maintenance] Maintenance worker started');
  return _worker;
}

/** Stable scheduler id: every instance upserts the same schedule, so Redis holds exactly one. */
export const PLATFORM_SYNC_SCHEDULER_ID = 'maintenance-platform-sync-sweep';
const PLATFORM_SYNC_STARTUP_DELAY_MS = 10_000;

type PlatformSyncScheduleQueue = Pick<
  Queue<SystemMaintenanceJobData>,
  'add' | 'upsertJobScheduler' | 'removeJobScheduler'
>;

/**
 * Register the platform sync sweep (previously a node-cron task in every API process).
 * The tick is a BullMQ job scheduler, so one job is produced per interval no matter how many
 * instances register it. The upsert also replaces the schedule when SYNC_INTERVAL_MINUTES
 * changes between deploys, and SYNC_ENABLED=false removes it.
 */
export async function schedulePlatformSyncSweep(queue: PlatformSyncScheduleQueue): Promise<void> {
  if (!env.SYNC_ENABLED) {
    await queue.removeJobScheduler(PLATFORM_SYNC_SCHEDULER_ID);
    logger.info('[maintenance] Platform sync sweep disabled via SYNC_ENABLED=false', { job: 'platform-sync' });
    return;
  }

  const intervalMinutes = env.SYNC_INTERVAL_MINUTES;
  await queue.upsertJobScheduler(
    PLATFORM_SYNC_SCHEDULER_ID,
    { pattern: `*/${intervalMinutes} * * * *` },
    {
      name: 'platform-sync-sweep',
      data: { task: 'platform_sync_sweep' },
      opts: {
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      },
    }
  );

  // One sweep shortly after boot, as the API used to do. Deduplicated for one interval so
  // several instances (or a rolling deploy) enqueue it once.
  await queue.add(
    'platform-sync-sweep-startup',
    { task: 'platform_sync_sweep' },
    {
      delay: PLATFORM_SYNC_STARTUP_DELAY_MS,
      deduplication: { id: 'maintenance-platform-sync-startup', ttl: intervalMinutes * 60 * 1000 },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  logger.info('[maintenance] Platform sync sweep scheduled', {
    job: 'platform-sync',
    intervalMinutes,
    cooldownMs: env.SYNC_COOLDOWN_MS,
  });
}

/**
 * Schedule recurring maintenance jobs.
 * Call once during boot to set up repeatable BullMQ jobs.
 */
export async function scheduleMaintenanceTasks(): Promise<void> {
  const redis = getRedisClient();

  _queue = new Queue<SystemMaintenanceJobData>(QueueNames.SYSTEM_MAINTENANCE, {
    connection: redis,
    telemetry: getQueueTelemetry(),
  });

  await scheduleQuestGeneration(_queue);
  await scheduleQuestExpiration(_queue);

  // DLQ cleanup every 6 hours
  await _queue.add(
    'cleanup-dlq',
    { task: 'cleanup_failed_jobs' },
    {
      repeat: { every: 6 * 60 * 60 * 1000 },
      jobId: 'maintenance-dlq-cleanup',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  // Prune SSE resources every hour
  await _queue.add(
    'prune-events',
    { task: 'prune_old_events' },
    {
      repeat: { every: 60 * 60 * 1000 },
      jobId: 'maintenance-prune-events',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  // Health check every 5 minutes
  await _queue.add(
    'health-check',
    { task: 'health_check' },
    {
      repeat: { every: 5 * 60 * 1000 },
      jobId: 'maintenance-health-check',
      removeOnComplete: { count: 3 },
      removeOnFail: { count: 5 },
    }
  );

  // Generate daily missions at 00:05 UTC every day
  await _queue.add(
    'generate-daily-missions',
    { task: 'generate_daily_missions' },
    {
      repeat: { pattern: '5 0 * * *' }, // 00:05 UTC daily
      jobId: 'maintenance-daily-missions',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  // Generate weekly missions at 00:05 UTC every Monday
  await _queue.add(
    'generate-weekly-missions',
    { task: 'generate_weekly_missions' },
    {
      repeat: { pattern: '5 0 * * 1' }, // 00:05 UTC on Mondays
      jobId: 'maintenance-weekly-missions',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  // Cleanup stale sync locks every hour
  await _queue.add(
    'cleanup-stale-sync-locks',
    { task: 'cleanup_stale_sync_locks' },
    {
      repeat: { every: 60 * 60 * 1000 },
      jobId: 'maintenance-cleanup-sync-locks',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  // Retire the previous daily schedule before registering the hourly sweep.
  await _queue.removeRepeatable('streak-at-risk-check', { pattern: '0 18 * * *' }, 'maintenance-streak-at-risk');
  await _queue.add(
    'streak-at-risk-check',
    { task: 'streak_at_risk_check' },
    {
      repeat: { every: HOUR_MS },
      jobId: 'maintenance-streak-at-risk',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  // Close focus sessions that stopped heartbeating
  await _queue.add(
    'reap-stale-focus-sessions',
    { task: 'reap_stale_focus_sessions' },
    {
      repeat: { every: 5 * 60 * 1000 },
      jobId: 'maintenance-reap-focus-sessions',
      removeOnComplete: { count: 3 },
      removeOnFail: { count: 5 },
    }
  );

  // Archive DSA submissions older than 180 days: first Sunday of every month at 03:00 UTC.
  await _queue.add(
    'archive-dsa-submissions',
    { task: 'submission_archive' },
    {
      repeat: { pattern: '0 3 1-7 * 0', tz: 'UTC' },
      jobId: 'maintenance-submission-archive',
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  // Generate daily challenge at 23:00 UTC
  await _queue.add(
    'generate-daily-challenge',
    { task: 'generate_daily_challenge' },
    {
      repeat: { pattern: '0 23 * * *' }, // 23:00 UTC daily
      jobId: 'maintenance-daily-challenge',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  await _queue.add(
    'audit-public-profiles',
    { task: 'audit_public_profiles' },
    {
      repeat: { pattern: '0 3 * * *', tz: 'UTC' },
      jobId: 'maintenance-audit-public-profiles',
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  await _queue.add(
    'check-contest-starting-soon',
    { task: 'check_contest_starting_soon' },
    {
      repeat: { every: 60 * 1000 },
      jobId: 'maintenance-contest-starting-soon',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );

  await schedulePlatformSyncSweep(_queue);

  logger.info('[maintenance] Scheduled recurring maintenance tasks');
}

export async function stopMaintenanceWorker(): Promise<void> {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
}
