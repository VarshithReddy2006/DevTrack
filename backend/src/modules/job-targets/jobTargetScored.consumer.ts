import { randomUUID } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import { JobTarget } from '../../db/models/jobTarget.model.js';
import { ReadinessInput } from '../../db/models/readinessInput.model.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import type { ConsumerDefinition } from '../../shared/events/consumerRegistry.js';
import { jobTargetScoredV1Schema, type DomainEventEnvelope, type JobTargetScoredPayload } from '../../shared/events/eventContract.js';
import { QueueNames } from '../../shared/jobs/types.js';
import { logger } from '../../shared/logger.js';
import { eventBus } from '../../shared/sse/eventBus.js';

const NOTIFICATION_LEASE_MS = 30_000;

function validated(event: DomainEventEnvelope) {
  const parsed = jobTargetScoredV1Schema.safeParse(event.payload);
  if (event.type !== 'jobtarget.scored' || event.schemaVersion !== 1 || typeof event.id !== 'string' || !event.id.trim() || event.id.length > 200
    || typeof event.userId !== 'string' || !/^[a-fA-F0-9]{24}$/.test(event.userId) || !parsed.success) return null;
  // Case-insensitive duplicates must not consume multiple top-three goal slots.
  const seen = new Set<string>();
  const missingSkills = parsed.data.missingSkills.filter(skill => {
    const key = skill.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...parsed.data, jobTargetId: parsed.data.jobTargetId.toLowerCase(), missingSkills, scoredAt: new Date(parsed.data.scoredAt) };
}

/** Same timestamp ties use the event ID, so arrival order cannot decide the final projection. */
function olderThan(dateField: string, eventField: string, scoredAt: Date, eventId: string) {
  return { $or: [
    { [dateField]: null },
    { [dateField]: { $lt: scoredAt } },
    { [dateField]: scoredAt, [eventField]: null },
    { [dateField]: scoredAt, [eventField]: { $lt: eventId } },
  ] };
}

export async function handleJobTargetScored(event: DomainEventEnvelope, session?: ClientSession): Promise<void> {
  const score = validated(event);
  if (!score) {
    logger.warn('[jobtarget.scored] Ignoring malformed event', { eventId: event.id });
    return;
  }
  // Partial projection writes on a standalone DB would make retries unsafe.
  if (!session?.inTransaction()) throw new Error('jobtarget.scored requires an inbox transaction');
  const userId = new Types.ObjectId(event.userId);
  const target = await JobTarget.findOneAndUpdate({
    _id: score.jobTargetId, userId,
    ...olderThan('scoredAt', 'scoreEventId', score.scoredAt, event.id),
  }, { $set: {
    status: 'completed', matchScore: score.matchScore, missingSkills: score.missingSkills,
    scoredAt: score.scoredAt, scoreEventId: event.id, failureReason: null,
    scoreNotification: {},
  } }, { new: true, session, runValidators: true });
  // Missing/deleted/foreign targets and old events cannot create readiness goals or notifications.
  if (!target) return;

  await ReadinessInput.updateOne({ userId }, { $setOnInsert: { userId } }, { upsert: true, session });
  await ReadinessInput.updateOne({
    userId,
    ...olderThan('jobTargets.latestScore.scoredAt', 'jobTargets.latestScore.eventId', score.scoredAt, event.id),
  }, { $set: { 'jobTargets.latestScore': {
    ...score, eventId: event.id,
    highPrioritySkills: score.matchScore < 60 ? score.missingSkills.slice(0, 3) : [],
  } } }, { session, runValidators: true });
}

async function afterScoreCommit(event: DomainEventEnvelope): Promise<void> {
  const score = validated(event);
  if (!score) return;
  const userId = new Types.ObjectId(event.userId).toHexString();
  const filter = { _id: score.jobTargetId, userId, scoreEventId: event.id };
  if (!await JobTarget.exists(filter)) return;
  // The shared generation fence also prevents an in-flight old read refilling the cache.
  await cacheManager.invalidateReadinessGaps(userId);

  const leaseToken = randomUUID();
  const claimed = await JobTarget.findOneAndUpdate({
    ...filter, 'scoreNotification.notifiedAt': null,
    $or: [{ 'scoreNotification.leaseUntil': null }, { 'scoreNotification.leaseUntil': { $lte: new Date() } }],
  }, { $set: {
    'scoreNotification.leaseToken': leaseToken,
    'scoreNotification.leaseUntil': new Date(Date.now() + NOTIFICATION_LEASE_MS),
  } }, { new: true }).lean();
  if (!claimed) {
    // A competing publisher may still fail; keep this queue job retryable until it finishes.
    if (await JobTarget.exists({ ...filter, 'scoreNotification.notifiedAt': null })) {
      throw new Error('jobtarget.updated notification is leased; retry delivery');
    }
    return;
  }

  const ownedLease = { ...filter, 'scoreNotification.leaseToken': leaseToken };
  try {
    eventBus.publish({
      id: event.id, type: 'jobtarget.updated', userId,
      timestamp: claimed.scoredAt!.toISOString(),
      payload: {
        jobTargetId: String(claimed._id), status: 'completed', matchScore: claimed.matchScore,
        missingSkills: claimed.missingSkills, scoredAt: claimed.scoredAt!.toISOString(),
        highPrioritySkills: claimed.matchScore! < 60 ? claimed.missingSkills.slice(0, 3) : [],
      },
    }, userId);
    await JobTarget.updateOne(ownedLease, {
      $set: { 'scoreNotification.notifiedAt': new Date() },
      $unset: { 'scoreNotification.leaseToken': '', 'scoreNotification.leaseUntil': '' },
    });
  } catch (error) {
    await JobTarget.updateOne(ownedLease, { $unset: { 'scoreNotification.leaseToken': '', 'scoreNotification.leaseUntil': '' } });
    throw error;
  }
}

export const jobTargetScoredConsumer: ConsumerDefinition<JobTargetScoredPayload> = {
  name: 'jd.jobTargetScored', pool: 'xp', queue: QueueNames.DOMAIN_READINESS,
  dedup: 'inbox', retainInbox: true,
  handle: handleJobTargetScored,
  afterCommit: afterScoreCommit,
};
