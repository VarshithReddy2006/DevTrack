import { registerQuestConsumers } from '../../quests/questEvents.consumer.js';
import { registerStreakConsumers } from '../../streak/consumers/index.js';
import { registerRevisionXpConsumer } from '../../xp/consumers/revisionReviewed.consumer.js';
// src/modules/readiness/workers/domainReadiness.worker.ts: Runs the readiness domain consumers.
// The outbox relay enqueues one job per event (jobId = eventId) on `domain-readiness`; the job
// data is the event envelope. Each consumer registered for that queue is run through the inbox
// so a redelivered job is a no-op.

import { Worker, type Job } from 'bullmq';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { QueueNames, JobRetryConfig } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { logger } from '../../../shared/logger.js';
import { getConsumersForEvent } from '../../../shared/events/consumerRegistry.js';
import { runConsumer, type RunConsumerResult } from '../../../shared/events/runConsumer.js';
import type { DomainEventEnvelope } from '../../../shared/events/eventContract.js';
import { registerReadinessConsumers } from '../consumers/index.js';

let _worker: Worker<DomainEventEnvelope> | null = null;

/** Job handler, exported separately so tests can drive it without Redis. */
export async function processDomainReadinessJob(event: DomainEventEnvelope): Promise<RunConsumerResult[]> {
  const results: RunConsumerResult[] = [];
  for (const consumer of getConsumersForEvent(event.type)) {
    if (consumer.queue !== QueueNames.DOMAIN_READINESS) continue;
    results.push(await runConsumer(consumer, event));
  }
  return results;
}

export function startDomainReadinessWorker(): Worker<DomainEventEnvelope> {
  if (_worker) return _worker;
  registerReadinessConsumers();
  registerQuestConsumers();
  registerStreakConsumers();
  // Last, so a failing XP award does not hold back the consumers above.
  registerRevisionXpConsumer();

  _worker = createDlqWorker<DomainEventEnvelope>(
    QueueNames.DOMAIN_READINESS,
    async (job: Job<DomainEventEnvelope>) => {
      const results = await processDomainReadinessJob(job.data);
      logger.debug('[domain-readiness] Processed event', {
        event: 'domain_readiness_processed',
        jobId: job.id,
        eventType: job.data.type,
        consumers: results.map(r => `${r.consumerName}:${r.reason}`),
      });
      return results;
    },
    { connection: getRedisClient(), concurrency: 5, ...JobRetryConfig.xpProcessing },
  );

  _worker.on('failed', (job, err) => {
    logger.error('[domain-readiness] Job failed', err, { event: 'domain_readiness_failed', jobId: job?.id, eventType: job?.data.type });
  });
  _worker.on('error', err => {
    logger.error('[domain-readiness] Worker error', err, { event: 'domain_readiness_worker_error' });
  });
  logger.info('[domain-readiness] Worker started', { event: 'domain_readiness_worker_started', queue: QueueNames.DOMAIN_READINESS });
  return _worker;
}

export async function stopDomainReadinessWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
