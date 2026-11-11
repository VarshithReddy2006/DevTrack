// src/shared/jobs/streakRecalcWorker.ts — BullMQ streak recalculation worker
// Processes streak-recalc jobs from the queue.
// Called after platform sync completion to recalculate unified streaks.

import { createDlqWorker } from './dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../redis/index.js';
import { logger } from '../logger.js';
import { recalculateStreak } from '../../modules/streak/streak.service.js';
import { QueueNames, JobRetryConfig } from './types.js';

export interface StreakRecalcJobData {
  userId: string;
  streakType: 'dsa' | 'github' | 'unified';
  requestId?: string;
}

// Operational metrics
const metrics = {
  processed: 0,
  recalculated: 0,
  failed: 0,
  startedAt: Date.now(),
};

let _worker: Worker<StreakRecalcJobData> | null = null;

export function startStreakRecalcWorker(): Worker<StreakRecalcJobData> {
  if (_worker) return _worker;

  const redis = getRedisClient();

  _worker = createDlqWorker<StreakRecalcJobData>(
    QueueNames.STREAK_RECALC,
    async (job: Job<StreakRecalcJobData>) => {
      const { userId, streakType, requestId } = job.data;
      const jobId = job.id ?? 'unknown';
      const startTime = Date.now();

      logger.info('[streak-worker] Processing streak recalc job', {
        event: 'streak_job_started',
        queue: QueueNames.STREAK_RECALC,
        jobId,
        userId,
        streakType,
        requestId: requestId ?? jobId,
        attempt: job.attemptsMade + 1,
      });

      try {
        const result = await recalculateStreak(userId, streakType);

        const durationMs = Date.now() - startTime;
        metrics.processed++;
        metrics.recalculated++;

        logger.info('[streak-worker] Streak recalc completed', {
          event: 'streak_job_completed',
          queue: QueueNames.STREAK_RECALC,
          jobId,
          userId,
          streakType,
          durationMs,
          currentStreak: result.currentStreak,
          isActiveToday: result.isActiveToday,
        });

        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        metrics.failed++;

        logger.error('[streak-worker] Streak recalc failed', err as Error, {
          event: 'streak_job_failed',
          queue: QueueNames.STREAK_RECALC,
          jobId,
          userId,
          streakType,
          requestId: requestId ?? jobId,
          durationMs,
        });

        throw err;
      }
    },
    {
      connection: redis,
      concurrency: 5,
      ...JobRetryConfig.standard,
    }
  );

  _worker.on('completed', (job: Job<StreakRecalcJobData>) => {
    logger.debug('[streak-worker] Job completed', {
      event: 'streak_job_completed_event',
      queue: QueueNames.STREAK_RECALC,
      jobId: job.id,
      userId: job.data.userId,
    });
  });

  // Route permanently-failed jobs to the DLQ
  _worker.on('failed', (job: Job<StreakRecalcJobData> | undefined, err: Error) => {
    logger.error('[streak-worker] Job failed permanently', err, {
      event: 'streak_job_failed_permanently',
      queue: QueueNames.STREAK_RECALC,
      jobId: job?.id,
      userId: job?.data.userId,
    });
  });

  _worker.on('error', (err: Error) => {
    logger.error('[streak-worker] Worker error', err, { event: 'streak_worker_error' });
  });

  logger.info('[streak-worker] Streak recalc worker started', {
    event: 'streak_worker_started',
    queue: QueueNames.STREAK_RECALC,
    concurrency: 5,
  });

  return _worker;
}

export async function stopStreakRecalcWorker(): Promise<void> {
  if (!_worker) return;
  logger.info('[streak-worker] Stopping streak recalc worker', { event: 'streak_worker_stopping' });
  await _worker.close();
  _worker = null;
  logger.info('[streak-worker] Streak recalc worker stopped', { event: 'streak_worker_stopped' });
}

export function getStreakRecalcWorkerStatus(): {
  running: boolean;
  processed: number;
  recalculated: number;
  failed: number;
  uptimeSeconds: number;
} {
  return {
    running: _worker !== null,
    processed: metrics.processed,
    recalculated: metrics.recalculated,
    failed: metrics.failed,
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
  };
}
