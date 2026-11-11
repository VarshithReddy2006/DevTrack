import { createDlqWorker } from '../dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../../redis/index.js';
import { QueueNames } from '../types.js';
import { logger } from '../../logger.js';
import { SkillNodeVerificationEngine } from '../../../modules/readiness/engine/SkillNodeVerificationEngine.js';

export function startRoadmapRecommendationWorker(): Worker {
  const worker = createDlqWorker(
    QueueNames.READINESS_ROADMAP,
    async (job: Job) => {
      const { userId } = job.data;
      logger.info('[Worker] Processing Roadmap Verification', { userId });
      await SkillNodeVerificationEngine.verifyNodes({ userId });
    },
    { connection: getRedisClient() }
  );

  worker.on('failed', (job, err) => {
    logger.error('[Worker] Roadmap generation failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
