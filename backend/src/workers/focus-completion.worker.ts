import { registerQuestConsumers } from '../modules/quests/questEvents.consumer.js';
import type { Worker } from 'bullmq';
import { focusActivityConsumer } from '../modules/activity/consumers/focusSessionCompleted.consumer.js';
import { focusMissionConsumer } from '../modules/missions/consumers/focusSessionCompleted.consumer.js';
import { registerReadinessConsumers } from '../modules/readiness/consumers/index.js';
import { registerInterviewTurnAnsweredConsumer } from '../modules/interview/interviewTurnAnswered.consumer.js';
import { registerJobTargetSubmittedConsumer } from '../modules/job-targets/jobTargetSubmitted.consumer.js';
import { focusStreakConsumer } from '../modules/streak/consumers/focusSessionCompleted.consumer.js';
import { focusXpConsumer } from '../modules/xp/consumers/focusSessionCompleted.consumer.js';
import { getConsumersForEvent, getQueuesForEvent, registerConsumer } from '../shared/events/consumerRegistry.js';
import { focusSessionCompletedV1Schema, type DomainEventEnvelope } from '../shared/events/eventContract.js';
import { OutboxRelay, type OutboxRelayOptions } from '../shared/events/outboxRelay.js';
import { runConsumer } from '../shared/events/runConsumer.js';
import { createDlqWorker } from '../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../shared/jobs/queueFactory.js';
import { logger } from '../shared/logger.js';
import { getRedisClient } from '../shared/redis/index.js';
import { runJobInTrace } from '../shared/tracing/tracing.js';

const focusCompleted = 'focus.session.completed';
const focusConsumers = [focusXpConsumer, focusStreakConsumer, focusMissionConsumer, focusActivityConsumer];

export function registerFocusCompletionConsumers(): void {
  for (const consumer of focusConsumers) registerConsumer(focusCompleted, consumer);
}

export async function processFocusCompletionJob(queue: string, event: DomainEventEnvelope) {
  const consumer = getConsumersForEvent(focusCompleted).find(c => c.queue === queue);
  if (!consumer || event.type !== focusCompleted || event.schemaVersion !== 1) {
    throw new Error(`Unexpected focus completion event on ${queue}`);
  }
  const payload = focusSessionCompletedV1Schema.parse(event.payload);
  const traceContext = event.metadata?.traceContext as Record<string, string> | undefined;
  return runJobInTrace({ _trace: traceContext?.traceId ? traceContext : undefined },
    () => runConsumer(consumer, { ...event, payload }));
}

export function createDomainOutboxRelay(enqueue: OutboxRelayOptions['enqueue']): OutboxRelay {
  registerFocusCompletionConsumers();
  registerReadinessConsumers();
  registerJobTargetSubmittedConsumer();
  registerInterviewTurnAnsweredConsumer();
  registerQuestConsumers();
  return new OutboxRelay({
    resolveQueues: type => {
      const queues = getQueuesForEvent(type);
      if (!queues.length) throw new Error(`No queue registered for outbox event ${type}`);
      return queues;
    },
    enqueue,
    onError: (error, event) => logger.error('[outbox] Relay failed', error, { eventId: event?.eventId }),
  });
}

export function createFocusCompletionWorkers() {
  const workers: Worker<DomainEventEnvelope>[] = [];
  const relay = createDomainOutboxRelay(async (queue, jobId, event) => {
    if (getRedisClient().status !== 'ready') throw new Error('Redis unavailable for the outbox relay');
    await getOrCreateQueue(queue).add(event.type, event, { jobId });
  });

  return {
    async start() {
      for (const consumer of focusConsumers) {
        const queue = consumer.queue!;
        const worker = createDlqWorker<DomainEventEnvelope>(
          queue, job => processFocusCompletionJob(queue, job.data),
          { connection: getRedisClient(), concurrency: 5 },
        );
        worker.on('error', error => logger.error('[focus] Consumer worker error', error, { queue }));
        workers.push(worker);
      }
      await Promise.all(workers.map(worker => worker.waitUntilReady()));
      relay.start();
    },
    async stop() {
      await relay.stop();
      const drained = await Promise.allSettled(workers.map(worker => worker.close()));
      const errors = drained.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Focus completion worker cleanup failed');
    },
  };
}
