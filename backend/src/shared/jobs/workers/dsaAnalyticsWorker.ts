import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../../redis/index.js';
import { QueueNames } from '../types.js';
import { logger } from '../../logger.js';
import { DsaIntelligenceEngine } from '../../../modules/readiness/intelligence/DsaIntelligenceEngine.js';

export function startDsaAnalyticsWorker(): Worker {
  const worker = new Worker(
    QueueNames.READINESS_DSA,
    async (job: Job) => {
      const { userId } = job.data;
      logger.info('[Worker] Processing DSA analytics', { userId });
      await DsaIntelligenceEngine.generateIntelligence({ userId, platform: job.data.platform });
    },
    { connection: getRedisClient() }
  );

  worker.on('failed', (job, err) => {
    logger.error('[Worker] DSA analytics failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
