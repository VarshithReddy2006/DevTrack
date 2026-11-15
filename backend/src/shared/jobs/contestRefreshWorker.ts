import { Worker, Job, Queue } from 'bullmq';
import { logger } from '../logger.js';
import { QueueNames } from './types.js';
import { getOrCreateQueue } from './queueFactory.js';
import { getRedisClient } from '../redis/client.js';
import { createDlqWorker } from './dlq.service.js';
import { contestRefreshService } from '../../modules/platform-sync/contests/contestRefresh.service.js';

export const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export const contestRefreshQueue: Queue = getOrCreateQueue(QueueNames.CONTEST_REFRESH);

let worker: Worker | null = null;

export async function processContestRefresh(job: Job): Promise<unknown> {
  logger.info(`[contest-refresh-worker] Starting contest refresh job ${job.id}`);
  const result = await contestRefreshService.refreshAllContests();
  logger.info('[contest-refresh-worker] Contest refresh completed', { result });
  return result;
}

export function startContestRefreshWorker(): Worker {
  if (worker) return worker;

  worker = createDlqWorker(
    QueueNames.CONTEST_REFRESH,
    processContestRefresh,
    {
      connection: getRedisClient(),
      concurrency: 1,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(`[contest-refresh-worker] Job ${job?.id} failed with error: ${err.message}`, {
      error: err,
    });
  });

  return worker;
}

export async function scheduleContestRefreshTask(): Promise<void> {
  // Ensure repeatable job running every 6 hours
  await contestRefreshQueue.add(
    'contest-refresh',
    {},
    {
      repeat: { every: SIX_HOURS_MS },
      jobId: 'scheduled-contest-refresh',
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    }
  );
  logger.info('[contest-refresh-worker] Scheduled repeatable 6-hour contest refresh task');
}

export async function stopContestRefreshWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
