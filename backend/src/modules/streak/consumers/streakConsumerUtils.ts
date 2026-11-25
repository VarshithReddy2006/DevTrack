import { Types, type ClientSession } from 'mongoose';
import type { StreakType } from '../../../db/models/index.js';
import type { DomainEventEnvelope } from '../../../shared/events/eventContract.js';
import { logger } from '../../../shared/logger.js';
import { recordActivity } from '../streak.service.js';

export function resolveEventDate(candidate: unknown, fallbackTimestamp?: string): Date | null {
  const raw = candidate ?? fallbackTimestamp;
  if (raw === undefined || raw === null || raw === '') return new Date();
  const parsed = raw instanceof Date ? raw : new Date(String(raw));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export async function recordStreakDomainEvent(params: {
  consumerName: string;
  event: DomainEventEnvelope<string, unknown>;
  streakType: StreakType;
  source: string;
  activityDate: Date;
  timezone?: string;
  metadata?: Record<string, unknown>;
  session?: ClientSession;
}): Promise<boolean> {
  const { consumerName, event, streakType, source, activityDate, timezone, metadata, session } = params;
  if (!Types.ObjectId.isValid(event.userId)) {
    logger.warn(`[streak] Ignoring ${event.type} with invalid userId`, {
      consumer: consumerName,
      eventId: event.id,
      userId: event.userId,
    });
    return false;
  }

  await recordActivity(
    {
      userId: event.userId,
      streakType,
      source,
      activityDate,
      timezone,
      metadata: {
        eventId: event.id,
        eventType: event.type,
        ...metadata,
      },
    },
    { trustedCompletion: true, session }
  );

  return true;
}
