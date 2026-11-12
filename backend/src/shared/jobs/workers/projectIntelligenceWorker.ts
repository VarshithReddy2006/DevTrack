import { createDlqWorker } from '../dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../../redis/index.js';
import { QueueNames } from '../types.js';
import { logger } from '../../logger.js';
import { ProjectIntelligenceEngine } from '../../../modules/readiness/intelligence/ProjectIntelligenceEngine.js';

import { TrustAwareReadinessScoringEngine } from '../../../modules/readiness/scoring/TrustAwareReadinessScoringEngine.js';

export function startProjectIntelligenceWorker(): Worker {
  const worker = createDlqWorker(
    QueueNames.READINESS_PROJECTS,
    async (job: Job) => {
      const { userId } = job.data;
      logger.info('[Worker] Processing Project Intelligence', { userId });
      try {
        await ProjectIntelligenceEngine.generateIntelligence({ userId });
      } catch (error) {
        await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId, unavailablePillars: ['Projects'] });
        throw error;
      }
      await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId });
    },
    { connection: getRedisClient() }
  );

  worker.on('failed', (job, err) => {
    logger.error('[Worker] Project intelligence failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
