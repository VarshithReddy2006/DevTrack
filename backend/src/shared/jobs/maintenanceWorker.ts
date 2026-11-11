// src/shared/jobs/maintenanceWorker.ts — Periodic maintenance worker
// Runs DLQ cleanup, prunes expired SSE resources, and performs Redis hygiene.
// Designed to run on a cron schedule via BullMQ repeatable jobs.

import { Worker, Job, Queue } from 'bullmq';
import { getRedisClient } from '../redis/index.js';
import { logger } from '../logger.js';
import { createDlqWorker, dlqService, DLQ_QUEUE_NAMES } from './dlq.service.js';
import { QueueNames, SystemMaintenanceJobData } from './types.js';
import { generateDailyMissions, generateWeeklyMissions } from '../../modules/missions/missionGenerator.service.js';
import { cleanupStaleLocks } from '../redis/syncLock.service.js';
import { UserAnalytics, DailyChallenge } from '../../db/models/index.js';
import { AntiGamingWorker } from '../../modules/profile/antiGaming.worker.js';
import { getNotificationQueue } from './queueFactory.js';

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
    await generateDailyMissions();
    logger.info('[maintenance] Daily missions generated successfully');
  } catch (err) {
    logger.error('[maintenance] Daily mission generation failed', err);
  }
}

async function runGenerateWeeklyMissions(): Promise<void> {
  logger.info('[maintenance] Generating weekly missions');
  try {
    await generateWeeklyMissions();
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

async function runStreakAtRiskCheck(): Promise<void> {
  logger.info('[maintenance] Running streak at risk check');
  try {
    // Query all users with currentStreak > 0 and not active today
    const atRiskUsers = await UserAnalytics.find({
      currentStreak: { $gt: 0 },
      isActiveToday: false,
    }).select('userId currentStreak');

    const notificationQueue = getNotificationQueue();
    let notifiedCount = 0;

    for (const user of atRiskUsers) {
      try {
        await notificationQueue.add(
          'streak-at-risk',
          {
            type: 'streak_at_risk',
            userId: user.userId.toString(),
            data: { currentStreak: user.currentStreak },
          },
          { jobId: `streak-risk-${user.userId}-${Date.now()}` }
        );
        notifiedCount++;
      } catch (err) {
        logger.warn('[maintenance] Failed to enqueue streak at risk notification', {
          userId: user.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('[maintenance] Streak at risk check completed', {
      atRiskUsers: atRiskUsers.length,
      notifiedCount,
    });
  } catch (err) {
    logger.error('[maintenance] Streak at risk check failed', err);
  }
}

async function runGenerateDailyChallenge(): Promise<void> {
  logger.info('[maintenance] Generating daily challenge');
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD

    // Check if challenge already exists for tomorrow
    const existing = await DailyChallenge.findOne({ date: dateStr });
    if (existing) {
      logger.info('[maintenance] Daily challenge already exists for tomorrow', { date: dateStr });
      return;
    }

    // Simple challenge generation - rotate through a predefined set
    const challenges = [
      { title: 'Two Sum', difficulty: 'easy' as const, platform: 'leetcode' as const, xpReward: 25 },
      { title: 'Longest Substring Without Repeating Characters', difficulty: 'medium' as const, platform: 'leetcode' as const, xpReward: 50 },
      { title: 'Median of Two Sorted Arrays', difficulty: 'hard' as const, platform: 'leetcode' as const, xpReward: 100 },
    ];

    const dayOfMonth = tomorrow.getDate();
    const challenge = challenges[dayOfMonth % challenges.length];

    await DailyChallenge.create({
      date: dateStr,
      title: challenge.title,
      titleSlug: challenge.title.toLowerCase().replace(/\s+/g, '-'),
      description: `Complete the ${challenge.title} problem on ${challenge.platform}`,
      difficulty: challenge.difficulty,
      platform: challenge.platform,
      problemUrl: `https://${challenge.platform}.com/problemset/`,
      xpReward: challenge.xpReward,
      completionCount: 0,
    });

    logger.info('[maintenance] Daily challenge generated', { date: dateStr, title: challenge.title });
  } catch (err) {
    logger.error('[maintenance] Daily challenge generation failed', err);
  }
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
        case 'cleanup_failed_jobs':
          await runCleanupFailedJobs();
          break;
        case 'prune_old_events':
          await runPruneOldEvents();
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
          await runCleanupStaleSyncLocks();
          break;
        case 'streak_at_risk_check':
          await runStreakAtRiskCheck();
          break;
        case 'generate_daily_challenge':
          await runGenerateDailyChallenge();
          break;
        case 'audit_public_profiles':
          await AntiGamingWorker.startAuditJob(new Date(job.opts.prevMillis ?? job.timestamp));
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

/**
 * Schedule recurring maintenance jobs.
 * Call once during boot to set up repeatable BullMQ jobs.
 */
export async function scheduleMaintenanceTasks(): Promise<void> {
  const redis = getRedisClient();

  _queue = new Queue<SystemMaintenanceJobData>(QueueNames.SYSTEM_MAINTENANCE, {
    connection: redis,
  });

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

  // Streak at risk check daily at 18:00 UTC
  await _queue.add(
    'streak-at-risk-check',
    { task: 'streak_at_risk_check' },
    {
      repeat: { pattern: '0 18 * * *' }, // 18:00 UTC daily
      jobId: 'maintenance-streak-at-risk',
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
