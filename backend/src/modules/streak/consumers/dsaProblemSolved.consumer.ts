import type { ClientSession } from 'mongoose';
import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { DomainEventEnvelope, DsaProblemSolvedPayload } from '../../../shared/events/eventContract.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { logger } from '../../../shared/logger.js';
import { recordStreakDomainEvent, resolveEventDate } from './streakConsumerUtils.js';

/**
 * Handles `dsa.problem.solved` domain events and records timezone-safe DSA streak activity.
 */
export async function handleDsaProblemSolvedStreak(
  event: DomainEventEnvelope<string, DsaProblemSolvedPayload>,
  session?: ClientSession
): Promise<void> {
  const payload = event.payload;
  const problemId = typeof payload?.problemId === 'string' ? payload.problemId.trim() : '';
  const submissionId = typeof payload?.submissionId === 'string' ? payload.submissionId.trim() : '';
  const platform = typeof payload?.platform === 'string' ? payload.platform.trim().toLowerCase() : '';
  const activityDate = resolveEventDate(payload?.solvedAt, event.timestamp);

  if ((!problemId && !submissionId) || !activityDate) {
    logger.warn('[streak] Ignoring malformed dsa.problem.solved event', {
      eventId: event.id,
      userId: event.userId,
    });
    return;
  }

  const source = problemId
    ? platform
      ? `dsa_problem:${platform}:${problemId}`
      : `dsa_problem:${problemId}`
    : `dsa_submission:${submissionId}`;

  await recordStreakDomainEvent({
    consumerName: dsaProblemSolvedStreakConsumer.name,
    event,
    streakType: 'dsa',
    source,
    activityDate,
    timezone: typeof payload?.timezone === 'string' ? payload.timezone : undefined,
    metadata: {
      platform: platform || undefined,
      problemId: problemId || undefined,
      submissionId: submissionId || undefined,
      difficulty: payload?.difficulty,
    },
    session,
  });
}

export const dsaProblemSolvedStreakConsumer: ConsumerDefinition<DsaProblemSolvedPayload> = {
  name: 'streak.dsaProblemSolved',
  pool: 'xp',
  queue: QueueNames.DOMAIN_READINESS,
  dedup: 'inbox',
  handle: (event, session) => handleDsaProblemSolvedStreak(event, session),
};
