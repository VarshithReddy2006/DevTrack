// src/modules/xp/consumers/revisionReviewed.consumer.ts — Awards XP on revision.reviewed domain event
import { processXpEvent, type XpProcessingResult } from '../processor.js';
import { logger } from '../../../shared/logger.js';

export interface RevisionReviewedEvent {
  userId: string;
  cardId: string;
  reviewSeq: number;
  rating?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Handles revision.reviewed event by awarding 5 XP.
 * Natural key { sourceType: 'revision_review', sourceId: '<cardId>:<reviewSeq>' }
 * guarantees strict idempotency against duplicate delivery across workers.
 */
export async function handleRevisionReviewed(
  event: RevisionReviewedEvent
): Promise<XpProcessingResult> {
  const { userId, cardId, reviewSeq, rating, metadata } = event;

  if (!userId || !cardId || typeof reviewSeq !== 'number') {
    throw new Error('handleRevisionReviewed: missing required fields (userId, cardId, reviewSeq)');
  }

  const sourceId = `${cardId}:${reviewSeq}`;

  const result = await processXpEvent({
    userId,
    sourceType: 'revision_review',
    sourceId,
    metadata: {
      cardId,
      reviewSeq,
      rating,
      ...metadata,
    },
  });

  logger.info('handleRevisionReviewed: processed review XP award', {
    userId,
    sourceId,
    awarded: result.awarded,
    xpAwarded: result.xpAwarded,
    duplicate: result.duplicate,
  });

  return result;
}
