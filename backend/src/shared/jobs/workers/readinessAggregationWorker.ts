import { createDlqWorker } from '../dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../../redis/index.js';
import { QueueNames } from '../types.js';
import { logger } from '../../logger.js';
import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { TrustVerificationLayer } from '../../../modules/readiness/intelligence/TrustVerificationLayer.js';

export function startReadinessAggregationWorker(): Worker {
  const worker = createDlqWorker(
    QueueNames.READINESS_AGGREGATION,
    async (job: Job) => {
      const { userId } = job.data;
      logger.info('[Worker] Aggregating final readiness core snapshot', { userId });
      
      // Calculate final core score (simplified mock)
      const overallScore = 65; 

      await ReadinessCore.findOneAndUpdate(
        { userId },
        { overallScore, momentumTrend: 'improving', targetRoleAlignment: 75 },
        { upsert: true }
      );

      // Append trust confidence to snapshot
      await TrustVerificationLayer.computeConfidence(userId);
      
      logger.info('[Worker] Successfully aggregated readiness snapshot', { userId });
    },
    { connection: getRedisClient() }
  );

  worker.on('failed', (job, err) => {
    logger.error('[Worker] Readiness aggregation failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
