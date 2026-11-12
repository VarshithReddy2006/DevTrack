import { createDlqWorker } from '../dlq.service.js';
import { Worker, Job } from 'bullmq';
import { getRedisClient } from '../../redis/index.js';
import { QueueNames } from '../types.js';
import { logger } from '../../logger.js';
import { BenchmarkEngine } from '../../../modules/readiness/benchmark/BenchmarkEngine.js';

export function startBenchmarkWorker(): Worker {
  const worker = createDlqWorker(
    QueueNames.READINESS_BENCHMARKS,
    async (job: Job) => {
      const { userId } = job.data;
      logger.info('[Worker] Processing Benchmarks', { userId });
      await BenchmarkEngine.generateBenchmarks({ userId });
    },
    { connection: getRedisClient() }
  );

  worker.on('failed', (job, err) => {
    logger.error('[Worker] Benchmark generation failed', { jobId: job?.id, error: err.message });
  });

  return worker;
}
