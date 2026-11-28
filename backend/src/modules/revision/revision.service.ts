import { writeOutboxEvent, writeStandaloneOutboxEvent } from '../../shared/events/outbox.js';
// src/modules/revision/revision.service.ts — Revision cards service with optimistic concurrency
import { Types } from 'mongoose';
import { RevisionCard, type IRevisionCard } from '../../db/models/revisionCard.model.js';
import { computeNextSm2State, type ReviewRating } from './sm2.js';
import { processXpEvent } from '../xp/processor.js';
import { eventBus } from '../../shared/sse/index.js';
import { logger } from '../../shared/logger.js';

export class RevisionCardNotFoundError extends Error {
  constructor(message = 'Revision card not found') {
    super(message);
    this.name = 'RevisionCardNotFoundError';
  }
}

export class RevisionCardStaleError extends Error {
  code = 'REVISION_CARD_STALE';
  constructor(message = 'Card was updated in another session (reviewSeq mismatch)') {
    super(message);
    this.name = 'RevisionCardStaleError';
  }
}

export interface SubmitReviewParams {
  userId: string;
  cardId: string;
  rating: ReviewRating;
  reviewSeq: number;
  now?: Date;
}

export interface DueCardsQueryOptions {
  userId: string;
  limit?: number;
  now?: Date;
}

export class RevisionService {
  /**
   * Retrieves due cards for a user:
   * dueAt <= now AND (snoozedUntil == null OR snoozedUntil <= now)
   * Ordered by dueAt ASC, limited to the specified daily limit (default: 10, max: 50).
   */
  static async getDueCards(options: DueCardsQueryOptions): Promise<IRevisionCard[]> {
    const { userId, limit = 10, now = new Date() } = options;
    const safeLimit = Math.max(1, Math.min(limit, 50));
    const userObjId = new Types.ObjectId(userId);

    return RevisionCard.find({
      userId: userObjId,
      dueAt: { $lte: now },
      $or: [
        { snoozedUntil: null },
        { snoozedUntil: { $exists: false } },
        { snoozedUntil: { $lte: now } },
      ],
    })
      .sort({ dueAt: 1 })
      .limit(safeLimit)
      .exec();
  }

  /**
   * Transactional review submission with optimistic concurrency check (reviewSeq).
   * Atomically advances the card's SM-2 state, increments reviewSeq, emits revision.reviewed,
   * and dispatches XP reward to the XP engine.
   */
  static async submitReview(params: SubmitReviewParams): Promise<IRevisionCard> {
    const { userId, cardId, rating, reviewSeq, now = new Date() } = params;
    const userObjId = new Types.ObjectId(userId);
    const cardObjId = new Types.ObjectId(cardId);

    // Support transactional commit when replica set is active
    let updatedCard: IRevisionCard | null = null;
    let nextReviewSeq: number = 0;

    const executeReview = async (session?: any): Promise<IRevisionCard> => {
      let query = RevisionCard.findOne({ _id: cardObjId, userId: userObjId });
      if (session) query = query.session(session);
      const card = await query.exec();

      if (!card) {
        throw new RevisionCardNotFoundError();
      }

      // Optimistic concurrency check: stale submission detection
      if (card.reviewSeq !== reviewSeq) {
        throw new RevisionCardStaleError(
          `Stale review submission: expected seq ${card.reviewSeq}, got ${reviewSeq}`
        );
      }

      const sm2 = computeNextSm2State(
        {
          repetitions: card.repetitions,
          easeFactor: card.easeFactor,
          intervalDays: card.intervalDays,
        },
        rating,
        now
      );

      nextReviewSeq = card.reviewSeq + 1;

      const saved = await RevisionCard.findOneAndUpdate(
        { _id: cardObjId, userId: userObjId, reviewSeq },
        {
          $set: {
            reviewSeq: nextReviewSeq,
            repetitions: sm2.repetitions,
            easeFactor: sm2.easeFactor,
            intervalDays: sm2.intervalDays,
            dueAt: sm2.dueAt,
            lastReviewedAt: now,
          },
        },
        { new: true, ...(session ? { session } : {}) }
      );

      if (!saved) {
        throw new RevisionCardStaleError(
          `Stale review submission: card ${cardId} was updated concurrently (expected seq ${reviewSeq})`
        );
      }

      const reviewedEvent = { type: 'revision.reviewed', aggregateType: 'RevisionCard', aggregateId: cardId, userId,
        payload: { cardId, reviewSeq: nextReviewSeq, rating, reviewedAt: now.toISOString() } };
      if (session) {
        await writeOutboxEvent(session, reviewedEvent);
      } else {
        // The card is already saved. Failing the request now would not undo that, and
        // a client retry would only be rejected as stale, so log and carry on.
        try {
          await writeStandaloneOutboxEvent(`revision-reviewed_${cardId}_${nextReviewSeq}`, reviewedEvent);
        } catch (outboxErr) {
          logger.error('RevisionService: failed to persist revision.reviewed event', {
            userId,
            cardId,
            reviewSeq: nextReviewSeq,
            error: (outboxErr as Error).message,
          });
        }
      }

      return saved;
    };

    try {
      if (RevisionCard.db.readyState === 1 && typeof RevisionCard.db.transaction === 'function') {
        try {
          updatedCard = await RevisionCard.db.transaction(async (session) => {
            return executeReview(session);
          });
        } catch (txError: any) {
          // If transactions are not supported by the MongoDB deployment (e.g. standalone test runner)
          if (
            txError.message?.includes('Transactions are not supported') ||
            txError.message?.includes('replica set')
          ) {
            updatedCard = await executeReview();
          } else {
            throw txError;
          }
        }
      } else {
        updatedCard = await executeReview();
      }
    } catch (err) {
      throw err;
    }

    if (!updatedCard) {
      throw new RevisionCardNotFoundError();
    }

    // Award 5 XP right away. If this fails, the revision.reviewed consumer awards it
    // from the outbox under the same ledger key.
    try {
      await processXpEvent({
        userId,
        sourceType: 'revision_review',
        sourceId: `${cardId}:${nextReviewSeq}`,
        metadata: {
          cardId,
          rating,
          reviewSeq: nextReviewSeq,
          intervalDays: updatedCard.intervalDays,
        },
      });
    } catch (xpErr) {
      logger.error('RevisionService: inline XP award failed, leaving it to the outbox consumer', {
        userId,
        cardId,
        reviewSeq: nextReviewSeq,
        error: (xpErr as Error).message,
      });
    }

    // Emit SSE domain event
    try {
      eventBus.publish({
        type: 'revision_reviewed',
        userId,
        timestamp: now.toISOString(),
        payload: {
          cardId,
          reviewSeq: nextReviewSeq,
          rating,
          nextIntervalDays: updatedCard.intervalDays,
          nextDueAt: updatedCard.dueAt.toISOString(),
          easeFactor: updatedCard.easeFactor,
        },
      });
    } catch (eventErr) {
      logger.warn('RevisionService: failed to publish SSE event', {
        error: (eventErr as Error).message,
      });
    }

    return updatedCard;
  }
}
