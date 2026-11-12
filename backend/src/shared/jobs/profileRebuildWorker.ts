import { createDlqWorker } from './dlq.service.js';
import { Worker, Job } from 'bullmq';
import { logger } from '../logger.js';
import { PublicProfileService } from '../../modules/profile/publicProfile.service.js';
import { QueueNames } from './types.js';
import { getOrCreateQueue } from './queueFactory.js';
import { getRedisClient } from '../redis/client.js';

export const profileRebuildQueue = getOrCreateQueue(QueueNames.PROFILE_REBUILD);

export async function enqueueProfileRebuild(userId: string, reason: string) {
  // Use a debounce window based on userId and current 5-minute block
  const windowId = Math.floor(Date.now() / (5 * 60 * 1000));
  const jobId = `rebuild:${userId}:${windowId}`;

  await profileRebuildQueue.add(
    'rebuild',
    { userId, reason },
    { jobId } // ensures idempotency within the 5 minute window
  );
  
  logger.info(`[profile-rebuild] Enqueued profile rebuild for user ${userId}`, { reason, jobId });
}

let worker: Worker | null = null;

export function startProfileRebuildWorker() {
  if (worker) return worker;

  worker = createDlqWorker(
    QueueNames.PROFILE_REBUILD,
    async (job: Job) => {
      const { userId, reason } = job.data;
      logger.info(`[profile-rebuild] Processing rebuild for ${userId} (Reason: ${reason})`);
      
      try {
        await PublicProfileService.computeProfile(userId);
        logger.info(`[profile-rebuild] Rebuild successful for ${userId}`);
      } catch (error) {
        logger.error(`[profile-rebuild] Rebuild failed for ${userId}`, { error });
        throw error;
      }
    },
    { connection: getRedisClient(), concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    logger.error(`[profile-rebuild] Job ${job?.id} failed with error ${err.message}`);
  });

  return worker;
}

export async function stopProfileRebuildWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
