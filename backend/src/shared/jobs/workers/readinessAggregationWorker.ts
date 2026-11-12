import { createDlqWorker } from '../dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../../redis/index.js';
import { QueueNames } from '../types.js';
import { logger } from '../../logger.js';
import { TrustAwareReadinessScoringEngine } from '../../../modules/readiness/scoring/TrustAwareReadinessScoringEngine.js';

export function startReadinessAggregationWorker(): Worker {
  const worker = createDlqWorker(
    QueueNames.READINESS_AGGREGATION,
    async (job: Job) => {
      const { userId } = job.data;
      logger.info('[Worker] Aggregating final readiness core snapshot', { userId });
      
      await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId });

      logger.info('[Worker] Successfully aggregated readiness snapshot', { userId });
    },
    { connection: getRedisClient() }
  );

  worker.on('failed', (job, err) => {
    logger.error('[Worker] Readiness aggregation failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
