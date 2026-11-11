import { createDlqWorker } from '../dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../../redis/index.js';
import { QueueNames } from '../types.js';
import { logger } from '../../logger.js';
import { SkillIntelligenceEngine } from '../../../modules/readiness/intelligence/SkillIntelligenceEngine.js';

export function startSkillIntelligenceWorker(): Worker {
  const worker = createDlqWorker(
    QueueNames.READINESS_SKILLS,
    async (job: Job) => {
      const { userId } = job.data;
      logger.info('[Worker] Processing Skill Intelligence', { userId });
      await SkillIntelligenceEngine.generateIntelligence({ userId });
    },
    { connection: getRedisClient() }
  );

  worker.on('failed', (job, err) => {
    logger.error('[Worker] Skill intelligence failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
