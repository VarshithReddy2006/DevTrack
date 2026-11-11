// src/shared/jobs/notificationWorker.ts — BullMQ notification worker
// Processes notification jobs: streak_at_risk reminders, streak milestones.
// Delivers via the notification service (in-app + SSE).

import { createDlqWorker } from './dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../redis/index.js';
import { logger } from '../logger.js';
import { QueueNames, JobRetryConfig } from './types.js';
import { notificationService } from '../../modules/notifications/notification.service.js';

export interface NotificationJobData {
  type: 'streak_at_risk' | 'streak_milestone' | 'level_up' | 'inactivity';
  userId: string;
  data: Record<string, unknown>;
  requestId?: string;
}

// Operational metrics
const metrics = {
  processed: 0,
  delivered: 0,
  failed: 0,
  startedAt: Date.now(),
};

let _worker: Worker<NotificationJobData> | null = null;

export function startNotificationWorker(): Worker<NotificationJobData> {
  if (_worker) return _worker;

  const redis = getRedisClient();

  _worker = createDlqWorker<NotificationJobData>(
    QueueNames.NOTIFICATIONS,
    async (job: Job<NotificationJobData>) => {
      const { type, userId, data, requestId } = job.data;
      const jobId = job.id ?? 'unknown';
      const startTime = Date.now();

      logger.info('[notification-worker] Processing notification job', {
        event: 'notification_job_started',
        queue: QueueNames.NOTIFICATIONS,
        jobId,
        userId,
        type,
        requestId: requestId ?? jobId,
      });

      try {
        switch (type) {
          case 'streak_at_risk': {
            const currentStreak = (data.currentStreak as number) ?? 0;
            await notificationService.triggerStreakReminder(userId, currentStreak);
            break;
          }
          case 'streak_milestone': {
            const streakDays = (data.streakDays as number) ?? 0;
            await notificationService.triggerStreakMilestone(userId, streakDays);
            break;
          }
          case 'level_up': {
            const newLevel = (data.newLevel as number) ?? 1;
            await notificationService.triggerLevelUp(userId, newLevel);
            break;
          }
          case 'inactivity': {
            const daysSinceActive = (data.daysSinceActive as number) ?? 1;
            await notificationService.triggerInactivityReminder(userId, daysSinceActive);
            break;
          }
          default:
            logger.warn('[notification-worker] Unknown notification type', { type, userId });
        }

        const durationMs = Date.now() - startTime;
        metrics.processed++;
        metrics.delivered++;

        logger.info('[notification-worker] Notification delivered', {
          event: 'notification_job_completed',
          queue: QueueNames.NOTIFICATIONS,
          jobId,
          userId,
          type,
          durationMs,
        });
      } catch (err) {
        const durationMs = Date.now() - startTime;
        metrics.failed++;

        logger.error('[notification-worker] Notification delivery failed', err as Error, {
          event: 'notification_job_failed',
          queue: QueueNames.NOTIFICATIONS,
          jobId,
          userId,
          type,
          durationMs,
        });

        throw err;
      }
    },
    {
      connection: redis,
      concurrency: 3,
      ...JobRetryConfig.standard,
    }
  );

  _worker.on('completed', (job: Job<NotificationJobData>) => {
    logger.debug('[notification-worker] Job completed', {
      event: 'notification_job_completed_event',
      queue: QueueNames.NOTIFICATIONS,
      jobId: job.id,
      userId: job.data.userId,
    });
  });

  // Route permanently-failed jobs to the DLQ
  _worker.on('failed', (job: Job<NotificationJobData> | undefined, err: Error) => {
    logger.error('[notification-worker] Job failed permanently', err, {
      event: 'notification_job_failed_permanently',
      queue: QueueNames.NOTIFICATIONS,
      jobId: job?.id,
      userId: job?.data.userId,
    });
  });

  _worker.on('error', (err: Error) => {
    logger.error('[notification-worker] Worker error', err, { event: 'notification_worker_error' });
  });

  logger.info('[notification-worker] Notification worker started', {
    event: 'notification_worker_started',
    queue: QueueNames.NOTIFICATIONS,
    concurrency: 3,
  });

  return _worker;
}

export async function stopNotificationWorker(): Promise<void> {
  if (!_worker) return;
  logger.info('[notification-worker] Stopping notification worker', { event: 'notification_worker_stopping' });
  await _worker.close();
  _worker = null;
  logger.info('[notification-worker] Notification worker stopped', { event: 'notification_worker_stopped' });
}

export function getNotificationWorkerStatus(): {
  running: boolean;
  processed: number;
  delivered: number;
  failed: number;
  uptimeSeconds: number;
} {
  return {
    running: _worker !== null,
    processed: metrics.processed,
    delivered: metrics.delivered,
    failed: metrics.failed,
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
  };
}
