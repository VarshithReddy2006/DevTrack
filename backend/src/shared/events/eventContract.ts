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
  | 'jobtarget.parsed'
  | 'contest.starting-soon'
  | 'league.week.finalized'
  // Public profile integrity
  | 'profile.flagged'
  // Public portfolio publication
  | 'profile.published'
  | 'profile.unpublished';

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

export interface ProfilePublicationPayload {
  slug: string;
  publicationVersion: number;
}

export interface ProfileFlaggedPayload {
  suspicionScore: number;
  previousSuspicionScore: number | null;
  flags: string[];
}

/** Emitted when a focus session is closed as completed. Carries what the XP rules need to judge it. */
export interface FocusSessionCompletedPayload {
  sessionId: string;
  plannedDurationMinutes: number;
  activeDurationMs: number;
  coveredHeartbeatIntervals?: number;
  /** ISO-8601; falls back to the envelope timestamp when absent. */
  completedAt?: string;
}

export interface RevisionReviewedPayload {
  cardId: string;
  reviewSeq: number;
  rating: 'failed' | 'hard' | 'easy';
  /** ISO-8601; falls back to the envelope timestamp when absent. */
  reviewedAt?: string;
}

/** Emitted by the JD parse pipeline once a job target has been parsed and scored. */
export interface JobTargetParsedPayload {
  jobTargetId: string;
  targetRole?: string;
  company?: string;
  requiredSkills?: string[];
  analysisMode?: 'ai' | 'taxonomy_only';
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
export type ProfilePublishedEvent = DomainEventEnvelope<'profile.published', ProfilePublicationPayload>;
export type ProfileUnpublishedEvent = DomainEventEnvelope<'profile.unpublished', ProfilePublicationPayload>;
export type ProfileFlaggedEvent = DomainEventEnvelope<'profile.flagged', ProfileFlaggedPayload>;
export type FocusSessionCompletedEvent = DomainEventEnvelope<'focus.session.completed', FocusSessionCompletedPayload>;
export type RevisionReviewedEvent = DomainEventEnvelope<'revision.reviewed', RevisionReviewedPayload>;
export type JobTargetParsedEvent = DomainEventEnvelope<'jobtarget.parsed', JobTargetParsedPayload>;
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
