// src/shared/jobs/platformSyncWorker.ts
import { Job, Worker } from 'bullmq';
import { WorkerFactory } from '../../infrastructure/queues/WorkerFactory.js';
import { getRedisClient } from '../redis/index.js';
import { logger } from '../logger.js';
import { eventBus } from '../sse/index.js';
import { syncState } from '../syncState.js';
import { syncPlatform } from '../../modules/platform-sync/sync.service.js';
import { PlatformSyncJobData, QueueNames, JobRetryConfig } from './types.js';
import { getXpProcessingQueue, getStreakRecalcQueue } from './queueFactory.js';
import { dlqService } from './dlq.service.js';
import { injectTraceIntoJob, runJobInTrace } from '../tracing/tracing.js';

let _worker: Worker<PlatformSyncJobData> | null = null;

export function startPlatformSyncWorker(): Worker<PlatformSyncJobData> {
  if (_worker) return _worker;

  const redis = getRedisClient();

  _worker = WorkerFactory.createWorker<PlatformSyncJobData>(
    QueueNames.PLATFORM_SYNC,
    async (job: Job<PlatformSyncJobData>) => {
      // Restore distributed trace context from job data so all logs/spans are correlated
      return runJobInTrace(job.data as unknown as Record<string, unknown>, async () => {
        const { userId, platformName, requestId } = job.data;
        const jobId = job.id ?? 'unknown';
        const startTime = Date.now();

        logger.info('[worker] Processing platform sync job', {
          event: 'job_started',
          queue: QueueNames.PLATFORM_SYNC,
          jobId,
          userId,
          platform: platformName,
          requestId: requestId ?? jobId,
          attempt: job.attemptsMade + 1,
        });

        syncState.beginSync();

        try {
          const result = await syncPlatform(userId, platformName);

          const durationMs = Date.now() - startTime;
          logger.info('[worker] Platform sync job completed', {
            event: 'job_completed',
            queue: QueueNames.PLATFORM_SYNC,
            jobId,
            userId,
            platform: platformName,
            requestId: requestId ?? jobId,
            durationMs,
            success: result.success,
            stats: result.stats ?? null,
            error: result.error ?? null,
          });

          syncState.completeSync(result.success ? 'success' : 'failed', durationMs);

          if (result.success) {

            // Enqueue XP award — inject current trace so XP worker logs are correlated
            try {
              const xpQueue = getXpProcessingQueue();
              const syncSourceId = `sync_${userId}_${platformName}_${Date.now()}`;
              const xpJobData = injectTraceIntoJob({
                userId,
                sourceType: 'sync_completed',
                sourceId: syncSourceId,
                metadata: { platform: platformName, stats: result.stats },
                requestId: requestId ?? jobId,
              });
              await xpQueue.add(
                'sync-completed-xp',
                xpJobData,
                { jobId: `xp-sync-${platformName}-${userId}-${Date.now()}` }
              );
              logger.debug('[worker] XP job enqueued for sync completion', {
                event: 'xp_job_enqueued',
                userId,
                platform: platformName,
              });
            } catch (xpErr) {
              // XP failure must NOT fail the sync pipeline
              logger.warn('[worker] XP enqueue failed (non-fatal)', {
                event: 'xp_enqueue_failed',
                userId,
                platform: platformName,
                error: xpErr instanceof Error ? xpErr.message : String(xpErr),
              });
            }

            // Enqueue streak recalculation after sync
            try {
              const streakQueue = getStreakRecalcQueue();
              await streakQueue.add(
                'post-sync-recalc',
                {
                  userId,
                  streakType: 'unified' as const,
                  requestId: requestId ?? jobId,
                },
                { jobId: `streak-${userId}-${Date.now()}` }
              );
              logger.debug('[worker] Streak recalc enqueued', {
                event: 'streak_recalc_enqueued',
                userId,
                platform: platformName,
              });
            } catch (streakErr) {
              logger.warn('[worker] Streak recalc enqueue failed (non-fatal)', {
                event: 'streak_enqueue_failed',
                userId,
                error: streakErr instanceof Error ? streakErr.message : String(streakErr),
              });
            }
          }

          return result;
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const errorMessage = err instanceof Error ? err.message : String(err);

          logger.error('[worker] Platform sync job failed', err, {
            event: 'job_failed',
            queue: QueueNames.PLATFORM_SYNC,
            jobId,
            userId,
            platform: platformName,
            requestId: requestId ?? jobId,
            durationMs,
            attempt: job.attemptsMade + 1,
            maxAttempts: JobRetryConfig.platformSync.attempts,
          });

          syncState.completeSync('failed', durationMs);
          eventBus.emitSyncFailed(userId, platformName, errorMessage);

          throw err;
        }
      });
    },
    { concurrency: 5, ...JobRetryConfig.platformSync }
  );

  _worker.on('completed', (job: Job<PlatformSyncJobData>) => {
    logger.info('[worker] Job completed', {
      event: 'job_completed_event',
      queue: QueueNames.PLATFORM_SYNC,
      jobId: job.id,
      userId: job.data.userId,
    });
  });

  // Route permanently-failed jobs to the DLQ — previously this only logged
  _worker.on('failed', (job: Job<PlatformSyncJobData> | undefined, err: Error) => {
    logger.error('[worker] Job failed permanently', err, {
      event: 'job_failed_permanently',
      queue: QueueNames.PLATFORM_SYNC,
      jobId: job?.id,
      userId: job?.data.userId,
      attempt: job?.attemptsMade,
    });

    if (job && job.attemptsMade >= JobRetryConfig.platformSync.attempts) {
      dlqService
        .quarantineJob(
          QueueNames.PLATFORM_SYNC,
          job as unknown as import('bullmq').Job,
          err.message,
          job.attemptsMade,
          JobRetryConfig.platformSync.attempts
        )
        .catch((dlqErr) => {
          logger.error('[worker] Failed to quarantine job in DLQ', dlqErr, {
            event: 'dlq_quarantine_failed',
            jobId: job?.id,
          });
        });
    }
  });

  _worker.on('error', (err: Error) => {
    logger.error('[worker] Worker error', err, { event: 'worker_error' });
  });

  logger.info('[worker] Platform sync worker started', {
    event: 'worker_started',
    queue: QueueNames.PLATFORM_SYNC,
    concurrency: 5,
  });

  return _worker;
}

export async function stopPlatformSyncWorker(): Promise<void> {
  if (!_worker) return;

  logger.info('[worker] Stopping platform sync worker', { event: 'worker_stopping' });
  await _worker.close();
  _worker = null;
  logger.info('[worker] Platform sync worker stopped', { event: 'worker_stopped' });
}

export function getWorkerStatus(): { running: boolean } {
  return { running: _worker !== null };
}
