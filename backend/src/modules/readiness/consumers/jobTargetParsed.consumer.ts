// src/modules/readiness/consumers/jobTargetParsed.consumer.ts
// Records the job targets a user has had parsed and keeps the newest parsed JD
// requirements as the readiness target role context.
import type { ClientSession } from 'mongoose';
import { ReadinessInput } from '../../../db/models/readinessInput.model.js';
import { logger } from '../../../shared/logger.js';
import type { ConsumerDefinition } from '../../../shared/events/consumerRegistry.js';
import type { DomainEventEnvelope, JobTargetParsedPayload } from '../../../shared/events/eventContract.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { eventTime, toObjectId } from './readinessInputs.js';

const MAX_REQUIRED_SKILLS = 50;

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;

export async function handleJobTargetParsed(
  event: DomainEventEnvelope<'jobtarget.parsed', JobTargetParsedPayload>,
  session?: ClientSession,
): Promise<void> {
  const userId = toObjectId(event.userId);
  const { payload } = event;
  const parsedAt = eventTime(undefined, event.timestamp);
  if (!userId || !parsedAt || typeof payload?.jobTargetId !== 'string' || !payload.jobTargetId) {
    // A retry cannot fix a malformed event, so drop it instead of looping.
    logger.warn('[readiness] Ignoring malformed jobtarget.parsed event', { eventId: event.id });
    return;
  }

  // A set keeps a re-parse of the same target from counting twice.
  await ReadinessInput.updateOne(
    { userId },
    { $addToSet: { 'jobTargets.targetIds': payload.jobTargetId } },
    { upsert: true, session },
  );

  // Parses can finish out of order, so only a newer (or first) parse replaces the context.
  const requiredSkills = [...new Set((Array.isArray(payload.requiredSkills) ? payload.requiredSkills : [])
    .map(optionalText).filter((skill): skill is string => !!skill))].slice(0, MAX_REQUIRED_SKILLS);
  await ReadinessInput.updateOne(
    {
      userId,
      $or: [{ 'jobTargets.latest.parsedAt': { $exists: false } }, { 'jobTargets.latest.parsedAt': { $lte: parsedAt } }],
    },
    {
      $set: {
        'jobTargets.latest': {
          jobTargetId: payload.jobTargetId,
          targetRole: optionalText(payload.targetRole),
          company: optionalText(payload.company),
          requiredSkills,
          analysisMode: payload.analysisMode === 'ai' || payload.analysisMode === 'taxonomy_only' ? payload.analysisMode : undefined,
          parsedAt,
        },
      },
    },
    { session },
  );
}

export const jobTargetParsedConsumer: ConsumerDefinition<JobTargetParsedPayload> = {
  name: 'readiness.jobTargetParsed',
  pool: 'xp',
  queue: QueueNames.DOMAIN_READINESS,
  dedup: 'inbox',
  handle: (event, session) => handleJobTargetParsed(event, session),
};
