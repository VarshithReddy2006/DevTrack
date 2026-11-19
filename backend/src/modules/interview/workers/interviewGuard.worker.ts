import type { Worker } from 'bullmq';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { JobRetryConfig, QueueNames } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { logger } from '../../../shared/logger.js';
import type { InterviewGuardService } from '../interviewGuard.service.js';

/** #347 must bind the real model and evaluation adapter, then load this lifecycle in maintenance/all. */
export function createInterviewGuardWorker(service: Pick<InterviewGuardService, 'sweep'>) {
  let worker: Worker | null = null;
  let starting: Promise<void> | null = null;
  return {
    async start(): Promise<void> {
      if (starting) return starting;
      if (worker) return;
      starting = (async () => {
        const queue = getOrCreateQueue(QueueNames.INTERVIEW_GUARD);
        await queue.upsertJobScheduler('interview-guard-sweep', { every: 60_000 }, {
          name: 'interview.guard.sweep', data: {}, opts: JobRetryConfig.standard,
        });
        worker = createDlqWorker(QueueNames.INTERVIEW_GUARD, () => service.sweep(), {
          connection: getRedisClient(), concurrency: 1,
        });
        worker.on('error', error => logger.error('[interview-guard] Worker error', error));
        await service.sweep();
      })();
      try { await starting; } finally { starting = null; }
    },
    async stop(): Promise<void> {
      try { await starting; } finally {
        const current = worker;
        worker = null;
        await current?.close();
      }
      // Keep the shared scheduler for other replicas. Runtime owns QueueRegistry/Redis cleanup.
    },
  };
}
