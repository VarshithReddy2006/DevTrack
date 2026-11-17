// src/modules/readiness/consumers/revisionReviewed.consumer.ts
// Counts spaced repetition reviews into the 7-day readiness inputs and keeps the
// `revision:retention` evidence claim current.
import type { ClientSession } from 'mongoose';
import { ReadinessInput } from '../../../db/models/readinessInput.model.js';
import { logger } from '../../../shared/logger.js';
import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { DomainEventEnvelope, RevisionReviewedPayload } from '../../../shared/events/eventContract.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import {
  dayKey,
  eventTime,
  isInWindow,
  loadReadinessInput,
  pruneExpiredDays,
  summarizeInputs,
  toObjectId,
  upsertEvidenceClaim,
} from './readinessInputs.js';

export const REVISION_RETENTION_SUBJECT_KEY = 'revision:retention';

/** Reviews needed in the window before the retention figure counts as fully verified. */
const FULL_CONFIDENCE_REVIEWS = 10;

const RATINGS: readonly string[] = ['failed', 'hard', 'easy'];

export async function handleRevisionReviewed(
  event: DomainEventEnvelope<'revision.reviewed', RevisionReviewedPayload>,
  session?: ClientSession,
  now: Date = new Date(),
): Promise<void> {
  const userId = toObjectId(event.userId);
  const { payload } = event;
  const reviewedAt = eventTime(payload?.reviewedAt, event.timestamp);
  if (!userId || !reviewedAt || typeof payload?.cardId !== 'string' || !RATINGS.includes(payload.rating)) {
    // A retry cannot fix a malformed event, so drop it instead of looping.
    logger.warn('[readiness] Ignoring malformed revision.reviewed event', { eventId: event.id });
    return;
  }

  const day = dayKey(reviewedAt);
  if (!isInWindow(day, now)) return;

  const bucket = `revisionDays.${day}`;
  await ReadinessInput.updateOne(
    { userId },
    { $inc: { [`${bucket}.reviews`]: 1, [`${bucket}.lapses`]: payload.rating === 'failed' ? 1 : 0 } },
    { upsert: true, session },
  );

  const doc = await loadReadinessInput(userId, session);
  if (!doc) return;
  await pruneExpiredDays(doc, now, session);

  const { revision } = summarizeInputs(doc, now);
  const retention = revision.retentionRate7d ?? 0;
  await upsertEvidenceClaim(userId, {
    subjectType: 'revision_retention',
    subjectKey: REVISION_RETENTION_SUBJECT_KEY,
    source: 'devtrack_revision',
    claimText: `Reviewed ${revision.cardsReviewed7d} spaced repetition card${revision.cardsReviewed7d === 1 ? '' : 's'} `
      + `in the last 7 days with ${Math.round(retention * 100)}% recalled.`,
    verificationStatus: revision.cardsReviewed7d >= FULL_CONFIDENCE_REVIEWS ? 'verified' : 'partial',
    confidence: retention * 100 * Math.min(1, revision.cardsReviewed7d / FULL_CONFIDENCE_REVIEWS),
  }, now, session);
}

export const revisionReviewedConsumer: ConsumerDefinition<RevisionReviewedPayload> = {
  name: 'readiness.revisionReviewed',
  pool: 'xp',
  queue: QueueNames.DOMAIN_READINESS,
  dedup: 'inbox',
  handle: (event, session) => handleRevisionReviewed(event, session),
};
