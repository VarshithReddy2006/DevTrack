import type { ClientSession } from 'mongoose';
import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { DomainEventEnvelope, RevisionReviewedPayload } from '../../../shared/events/eventContract.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { logger } from '../../../shared/logger.js';
import { recordStreakDomainEvent, resolveEventDate } from './streakConsumerUtils.js';

/**
 * Handles `revision.card_reviewed` and `revision.reviewed` domain events and
 * records timezone-safe revision streak activity.
 */
export async function handleRevisionCardReviewedStreak(
  event: DomainEventEnvelope<string, RevisionReviewedPayload>,
  session?: ClientSession
): Promise<void> {
  const payload = event.payload;
  const cardId = typeof payload?.cardId === 'string' ? payload.cardId.trim() : '';
  const activityDate = resolveEventDate(payload?.reviewedAt, event.timestamp);

  if (!cardId || !activityDate) {
    logger.warn('[streak] Ignoring malformed revision review event', {
      eventId: event.id,
      eventType: event.type,
      userId: event.userId,
    });
    return;
  }

  const hasReviewSeq = typeof payload?.reviewSeq === 'number' && Number.isFinite(payload.reviewSeq);
  const source = hasReviewSeq
    ? `revision_card:${cardId}:${payload.reviewSeq}`
    : `revision_card:${cardId}:${event.id}`;

  await recordStreakDomainEvent({
    consumerName: revisionCardReviewedStreakConsumer.name,
    event,
    streakType: 'revision',
    source,
    activityDate,
    timezone: typeof payload?.timezone === 'string' ? payload.timezone : undefined,
    metadata: {
      cardId,
      reviewSeq: hasReviewSeq ? payload.reviewSeq : undefined,
      rating: payload?.rating,
    },
    session,
  });
}

export const revisionCardReviewedStreakConsumer: ConsumerDefinition<RevisionReviewedPayload> = {
  name: 'streak.revisionCardReviewed',
  pool: 'xp',
  queue: QueueNames.DOMAIN_READINESS,
  dedup: 'inbox',
  handle: (event, session) => handleRevisionCardReviewedStreak(event, session),
};
