// src/shared/events/sseBridge.ts — Domain event to SSE bridge consumer
// Forwards allowlisted domain events to connected user SSE channels with envelope metadata.

import { logger } from '../logger.js';
import { eventBus } from '../sse/eventBus.js';
import type { SseEventType } from '../sse/eventBus.js';
import type { DomainEventEnvelope } from './eventContract.js';
import type { ConsumerDefinition } from './consumerRegistry.js';
import { consumerRegistry } from './consumerRegistry.js';

export const SSE_BRIDGE_ALLOWLIST: readonly string[] = [
  'sync.started',
  'sync.completed',
  'sync.failed',
  'xp.awarded',
  'xp.level_up',
  'streak.updated',
  'streak.broken',
  'streak.milestone',
  'achievement.unlocked',
  'challenge.completed',
  'goal.completed',
  'goal.progress',
  'notification.dispatched',
  'behavioral.message_sent',
  'focus.session.completed',
  'contest.starting-soon',
  'dsa.problem.solved',
  'revision.reviewed',
  'revision.card_reviewed',
  'league.week.finalized',
];

/**
 * Checks whether the given domain event type is permitted across the SSE bridge.
 */
export function isEventAllowlisted(eventType: string): boolean {
  return SSE_BRIDGE_ALLOWLIST.includes(eventType);
}

/**
 * Maps domain event type string to corresponding SseEventType.
 */
export function mapDomainEventToSseType(type: string): SseEventType {
  switch (type) {
    case 'sync.started':
      return 'sync_started';
    case 'sync.completed':
      return 'sync_completed';
    case 'sync.failed':
      return 'sync_failed';
    case 'xp.awarded':
      return 'xp_updated';
    case 'xp.level_up':
      return 'level_up';
    case 'streak.milestone':
      return 'streak_milestone';
    case 'streak.updated':
      return 'streak_updated';
    case 'achievement.unlocked':
      return 'achievement_unlocked';
    case 'challenge.completed':
      return 'challenge_completed';
    case 'goal.completed':
      return 'goal_completed';
    case 'behavioral.message_sent':
      return 'behavioral_message';
    case 'notification.dispatched':
      return 'notification_created';
    case 'focus.session.completed':
      return 'focus_session_completed';
    case 'contest.starting-soon':
      return 'contest_starting_soon';
    case 'dsa.problem.solved':
      return 'dsa_problem_solved';
    case 'revision.reviewed':
      return 'revision_reviewed';
    case 'revision.card_reviewed':
      return 'revision_card_reviewed' as SseEventType;
    case 'league.week.finalized':
      return 'league_week_finalized';
    default:
      return type.replace(/[\.\-]/g, '_') as SseEventType;
  }
}

/**
 * Forwards an allowlisted domain event to the user's active SSE stream.
 * Maintains schemaVersion, eventId, correlationId, and timestamp.
 */
export async function forwardDomainEventToSse(
  event: DomainEventEnvelope
): Promise<boolean> {
  if (!isEventAllowlisted(event.type)) {
    logger.debug('[sseBridge] Event type not allowlisted for SSE forward', {
      type: event.type,
      eventId: event.id,
    });
    return false;
  }

  if (!event.userId) {
    logger.debug('[sseBridge] Event has no userId; skipping SSE forward', {
      type: event.type,
      eventId: event.id,
    });
    return false;
  }

  const sseType = mapDomainEventToSseType(event.type);
  const payload = (event.payload || {}) as Record<string, unknown>;

  try {
    await eventBus.publishEnvelope(
      event.userId,
      sseType,
      payload,
      event.correlationId,
      event.schemaVersion
    );

    logger.debug('[sseBridge] Forwarded event to SSE channel', {
      eventId: event.id,
      eventType: event.type,
      sseType,
      userId: event.userId,
    });

    return true;
  } catch (error) {
    logger.error('[sseBridge] Failed to forward event to SSE', {
      eventId: event.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * SSE bridge consumer definition registered on allowlisted event types.
 */
export const sseBridgeConsumer: ConsumerDefinition = {
  name: 'sseBridgeConsumer',
  pool: 'sse',
  dedup: 'natural',
  handle: async (event: DomainEventEnvelope) => {
    await forwardDomainEventToSse(event);
  },
};

/**
 * Convenience helper to register the SSE bridge consumer across all allowlisted events.
 */
export function registerSseBridgeConsumers(): void {
  for (const eventType of SSE_BRIDGE_ALLOWLIST) {
    consumerRegistry.register(eventType, sseBridgeConsumer);
  }
}
