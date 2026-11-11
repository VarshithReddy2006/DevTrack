import { createDlqWorker } from '../dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../../redis/index.js';
import { QueueNames } from '../types.js';
import { logger } from '../../logger.js';
import { CohortBenchmarkEngine } from '../../../modules/readiness/engine/CohortBenchmarkEngine.js';

export function startBenchmarkWorker(): Worker {
  const worker = createDlqWorker(
    QueueNames.READINESS_BENCHMARKS,
    async (job: Job) => {
      const { userId, targetRole, currentScore } = job.data;
      logger.info('[Worker] Processing Benchmarks', { userId });
      await CohortBenchmarkEngine.computeBenchmarks(userId, targetRole || 'General Engineering', currentScore || 0);
    },
    { connection: getRedisClient() }
  );

  worker.on('failed', (job, err) => {
    logger.error('[Worker] Benchmark generation failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
