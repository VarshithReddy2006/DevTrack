// src/shared/events/eventContract.ts — Canonical Domain Event Contracts
// Every event in the system MUST use this envelope format.
// This ensures correlation/causation tracing, schema evolution, and replay safety.

// ---------------------------------------------------------------------------
// Canonical Event Envelope
// ---------------------------------------------------------------------------

export interface DomainEventEnvelope<T extends string = string, P = unknown> {
  /** Globally unique event ID */
  id: string;
  /** Event type discriminator */
  type: T;
  /** Schema version for forward-compatible evolution */
  schemaVersion: number;
  /** Trace ID from the originating HTTP request or job */
  correlationId: string;
  /** ID of the event that directly caused this event */
  causationId: string;
  /** User who triggered the event (empty for system events) */
  userId: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Event-specific payload */
  payload: P;
  /** Optional metadata for debugging */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Domain Event Types — exhaustive union
// ---------------------------------------------------------------------------

export type DomainEventType =
  // Ingestion lifecycle
  | 'sync.started'
  | 'sync.completed'
  | 'sync.failed'
  // Progression
  | 'xp.awarded'
  | 'xp.level_up'
  | 'streak.updated'
  | 'streak.broken'
  | 'streak.milestone'
  // Achievements & challenges
  | 'achievement.unlocked'
  | 'challenge.completed'
  | 'goal.completed'
  | 'goal.progress'
  // Notifications
  | 'notification.dispatched'
  | 'notification.suppressed'
  // Behavioral
  | 'behavioral.message_sent'
  | 'behavioral.fatigue_detected'
  // System / orchestration
  | 'orchestration.stage_failed'
  | 'orchestration.completed'
  | 'worker.poisoned'
  // Auth lifecycle
  | 'auth.login'
  | 'auth.logout'
  | 'auth.token_refreshed'
  | 'auth.session_revoked'
  // v2 Milestone domain events
  | 'focus.session.completed'
  | 'dsa.problem.solved'
  | 'revision.reviewed'
  | 'contest.starting-soon'
  | 'league.week.finalized';

// ---------------------------------------------------------------------------
// Typed Event Payloads
// ---------------------------------------------------------------------------

export interface SyncCompletedPayload {
  platform: string;
  newSubmissions: number;
  totalSolved: number;
  durationMs: number;
}

export interface XpAwardedPayload {
  amount: number;
  source: string;
  sourceId: string;
  newTotal: number;
  newLevel: number;
}

export interface StreakUpdatedPayload {
  currentStreak: number;
  longestStreak: number;
  streakRisk: number;
}

export interface AchievementUnlockedPayload {
  achievementId: string;
  name: string;
  tier: string;
}

export interface OrchestrationStageFailedPayload {
  stage: string;
  error: string;
  eventId: string;
  recoverable: boolean;
}

export interface WorkerPoisonedPayload {
  queue: string;
  jobId: string;
  attempts: number;
  maxAttempts: number;
  failureCategory: string;
}

// ---------------------------------------------------------------------------
// Convenience type aliases for common events
// ---------------------------------------------------------------------------

export type SyncCompletedEvent = DomainEventEnvelope<'sync.completed', SyncCompletedPayload>;
export type XpAwardedEvent = DomainEventEnvelope<'xp.awarded', XpAwardedPayload>;
export type StreakUpdatedEvent = DomainEventEnvelope<'streak.updated', StreakUpdatedPayload>;
export type AchievementUnlockedEvent = DomainEventEnvelope<'achievement.unlocked', AchievementUnlockedPayload>;
export type OrchestrationStageFailedEvent = DomainEventEnvelope<'orchestration.stage_failed', OrchestrationStageFailedPayload>;
export type WorkerPoisonedEvent = DomainEventEnvelope<'worker.poisoned', WorkerPoisonedPayload>;

// ---------------------------------------------------------------------------
// Factory: create a new event envelope with auto-populated fields
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';

export function createDomainEvent<T extends DomainEventType, P>(
  type: T,
  payload: P,
  opts: {
    userId: string;
    correlationId?: string;
    causationId?: string;
    schemaVersion?: number;
  }
): DomainEventEnvelope<T, P> {
  const id = randomUUID();
  return {
    id,
    type,
    schemaVersion: opts.schemaVersion ?? 1,
    correlationId: opts.correlationId ?? id,
    causationId: opts.causationId ?? id,
    userId: opts.userId,
    timestamp: new Date().toISOString(),
    payload,
  };
}
