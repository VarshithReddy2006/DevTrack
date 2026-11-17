// src/modules/readiness/consumers/focusSessionCompleted.consumer.ts
// Counts completed focus sessions into the 7-day readiness inputs and keeps the
// `focus:consistency` evidence claim current.
import type { ClientSession } from 'mongoose';
import { ReadinessInput } from '../../../db/models/readinessInput.model.js';
import { computeActiveSec, decideFocusXp } from '../../activity/focusXpDecision.js';
import { logger } from '../../../shared/logger.js';
import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { DomainEventEnvelope, FocusSessionCompletedPayload } from '../../../shared/events/eventContract.js';
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

export const FOCUS_CONSISTENCY_SUBJECT_KEY = 'focus:consistency';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Applies one `focus.session.completed` event. Safe to call inside the inbox transaction:
 * every write takes the session when one is given.
 *
 * A session counts as qualified under the same rules that decide focus XP (minimum planned
 * length, completion ratio, heartbeat coverage), minus the daily XP cap which has no meaning here.
 */
export async function handleFocusSessionCompleted(
  event: DomainEventEnvelope<'focus.session.completed', FocusSessionCompletedPayload>,
  session?: ClientSession,
  now: Date = new Date(),
): Promise<void> {
  const userId = toObjectId(event.userId);
  const { payload } = event;
  const completedAt = eventTime(payload?.completedAt, event.timestamp);
  if (!userId || !completedAt || typeof payload?.sessionId !== 'string'
    || !finite(payload.plannedDurationMinutes) || !finite(payload.activeDurationMs)) {
    // A retry cannot fix a malformed event, so drop it instead of looping.
    logger.warn('[readiness] Ignoring malformed focus.session.completed event', { eventId: event.id });
    return;
  }

  const day = dayKey(completedAt);
  if (!isInWindow(day, now)) return;

  const qualified = payload.qualified ?? decideFocusXp({
    plannedSec: payload.plannedDurationMinutes * 60,
    activeSec: computeActiveSec(payload.activeDurationMs),
    coveredHeartbeatIntervals: payload.coveredHeartbeatIntervals ?? 0,
  }, []).qualified;

  const bucket = `focusDays.${day}`;
  await ReadinessInput.updateOne(
    { userId },
    {
      $inc: {
        [`${bucket}.sessions`]: 1,
        ...(qualified && {
          [`${bucket}.qualifiedSessions`]: 1,
          [`${bucket}.qualifiedMinutes`]: payload.activeDurationMs / 60_000,
        }),
      },
    },
    { upsert: true, session },
  );

  if (!qualified) return;

  const doc = await loadReadinessInput(userId, session);
  if (!doc) return;
  await pruneExpiredDays(doc, now, session);

  const { focus } = summarizeInputs(doc, now);
  await upsertEvidenceClaim(userId, {
    subjectType: 'focus_consistency',
    subjectKey: FOCUS_CONSISTENCY_SUBJECT_KEY,
    source: 'devtrack_focus',
    claimText: `Completed ${focus.qualifiedSessions7d} qualified focus session${focus.qualifiedSessions7d === 1 ? '' : 's'} `
      + `(${focus.focusMinutes7d} min) on ${focus.activeDays7d} of the last 7 days: ${focus.consistencyTier} consistency.`,
    verificationStatus: focus.consistencyTier === 'strong' || focus.consistencyTier === 'steady' ? 'verified' : 'partial',
    confidence: (focus.activeDays7d / 7) * 100,
  }, now, session);
}

export const focusSessionCompletedConsumer: ConsumerDefinition<FocusSessionCompletedPayload> = {
  name: 'readiness.focusSessionCompleted',
  pool: 'xp',
  queue: QueueNames.DOMAIN_READINESS,
  dedup: 'inbox',
  handle: (event, session) => handleFocusSessionCompleted(event, session),
};
