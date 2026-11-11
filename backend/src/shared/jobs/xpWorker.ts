// src/shared/jobs/xpWorker.ts — BullMQ XP processing worker
// Processes XP events from the xp-processing queue with idempotency protection.
// Trace context is restored from the originating sync job for full distributed correlation.

import { createDlqWorker } from './dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../redis/index.js';
import { logger } from '../logger.js';
import { processXpEvent } from '../../modules/xp/processor.js';
import { QueueNames, JobRetryConfig, XpProcessingJobData } from './types.js';
import { runJobInTrace } from '../tracing/tracing.js';

// Operational metrics
const metrics = {
  processed: 0,
  awarded: 0,
  duplicates: 0,
  failed: 0,
  startedAt: Date.now(),
};

let _worker: Worker<XpProcessingJobData> | null = null;

export function startXpWorker(): Worker<XpProcessingJobData> {
  if (_worker) return _worker;

  const redis = getRedisClient();

  _worker = createDlqWorker<XpProcessingJobData>(
    QueueNames.XP_PROCESSING,
    async (job: Job<XpProcessingJobData>) => {
      // Restore distributed trace context from the originating sync worker
      return runJobInTrace(job.data as unknown as Record<string, unknown>, async () => {
        const { userId, sourceType, sourceId, difficulty, metadata, requestId } = job.data;
        const jobId = job.id ?? 'unknown';
        const startTime = Date.now();

        logger.info('[xp-worker] Processing XP job', {
          event: 'xp_job_started',
          queue: QueueNames.XP_PROCESSING,
          jobId,
          userId,
          sourceType,
          sourceId,
          difficulty,
          requestId: requestId ?? jobId,
          attempt: job.attemptsMade + 1,
        });

        try {
          const result = await processXpEvent({ userId, sourceType, sourceId, difficulty, metadata, requestId });

          const durationMs = Date.now() - startTime;
          metrics.processed++;
          if (result.awarded) metrics.awarded++;
          if (result.duplicate) metrics.duplicates++;

          logger.info('[xp-worker] XP job completed', {
            event: 'xp_job_completed',
            queue: QueueNames.XP_PROCESSING,
            jobId,
            userId,
            sourceType,
            durationMs,
            awarded: result.awarded,
            duplicate: result.duplicate,
            xpAwarded: result.xpAwarded,
            leveledUp: result.leveledUp,
          });

          return result;
        } catch (err) {
          const durationMs = Date.now() - startTime;
          metrics.failed++;

          logger.error('[xp-worker] XP job failed', err as Error, {
            event: 'xp_job_failed',
            queue: QueueNames.XP_PROCESSING,
            jobId,
            userId,
            sourceType,
            requestId: requestId ?? jobId,
            durationMs,
          });

          throw err;
        }
      });
    },
    {
      connection: redis,
      concurrency: 10,
      ...JobRetryConfig.xpProcessing,
    }
  );

  _worker.on('completed', (job: Job<XpProcessingJobData>) => {
    logger.debug('[xp-worker] Job completed', {
      event: 'xp_job_completed_event',
      queue: QueueNames.XP_PROCESSING,
      jobId: job.id,
      userId: job.data.userId,
    });
  });

  // Route permanently-failed XP jobs to the DLQ
  _worker.on('failed', (job: Job<XpProcessingJobData> | undefined, err: Error) => {
    logger.error('[xp-worker] Job failed permanently', err, {
      event: 'xp_job_failed_permanently',
      queue: QueueNames.XP_PROCESSING,
      jobId: job?.id,
      userId: job?.data.userId,
    });
  });

  _worker.on('error', (err: Error) => {
    logger.error('[xp-worker] Worker error', err, { event: 'xp_worker_error' });
  });

  logger.info('[xp-worker] XP worker started', {
    event: 'xp_worker_started',
    queue: QueueNames.XP_PROCESSING,
    concurrency: 10,
  });

  return _worker;
}

export async function stopXpWorker(): Promise<void> {
  if (!_worker) return;
  logger.info('[xp-worker] Stopping XP worker', { event: 'xp_worker_stopping' });
  await _worker.close();
  _worker = null;
  logger.info('[xp-worker] XP worker stopped', { event: 'xp_worker_stopped' });
}

export function getXpWorkerStatus(): {
  running: boolean;
  processed: number;
  awarded: number;
  duplicates: number;
  failed: number;
  uptimeSeconds: number;
} {
  return {
    running: _worker !== null,
    processed: metrics.processed,
    awarded: metrics.awarded,
    duplicates: metrics.duplicates,
    failed: metrics.failed,
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
  };
}