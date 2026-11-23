// src/shared/events/eventContract.ts — Canonical Domain Event Contracts
// Every event in the system MUST use this envelope format.
// This ensures correlation/causation tracing, schema evolution, and replay safety.

import { z } from 'zod';

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
  | 'dsa.submission.evaluated'
  | 'revision.card_created'
  | 'revision.reviewed'
  | 'jobtarget.submitted'
  | 'quest.completed'
  | 'quest.claimed'
  | 'jobtarget.parsed'
  | 'jobtarget.scored'
  | 'contest.starting-soon'
  | 'league.week.finalized'
  | 'interview.turn.answered'
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
  qualified?: boolean;
  /** ISO-8601; falls back to the envelope timestamp when absent. */
  completedAt?: string;
}

export const focusSessionCompletedV1Schema = z.object({
  sessionId: z.string().regex(/^[a-f0-9]{24}$/),
  plannedDurationMinutes: z.number().finite(),
  activeDurationMs: z.number().finite().nonnegative(),
  coveredHeartbeatIntervals: z.number().int().nonnegative(),
  completedAt: z.string().datetime(),
  mode: z.string().min(1),
  timezone: z.string().min(1),
  qualified: z.boolean(),
});

export type FocusSessionCompletedV1 = z.infer<typeof focusSessionCompletedV1Schema>;

export interface RevisionReviewedPayload {
  cardId: string;
  reviewSeq: number;
  rating: 'failed' | 'hard' | 'easy';
  /** ISO-8601; falls back to the envelope timestamp when absent. */
  reviewedAt?: string;
}

export interface JobTargetSubmittedPayload {
  jobTargetId: string;
  source: 'url' | 'text';
}

/** Emitted by the JD parse pipeline once a job target has been parsed and scored. */
export interface JobTargetParsedPayload {
  jobTargetId: string;
  targetRole?: string;
  company?: string;
  requiredSkills?: string[];
  analysisMode?: 'ai' | 'taxonomy_only';
}

/** Percentage score (0–100), with missing skills ordered by the scorer's priority. */
export const jobTargetScoredV1Schema = z.object({
  jobTargetId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  matchScore: z.number().finite().min(0).max(100),
  missingSkills: z.array(z.string().trim().min(1).max(200)).max(50),
  scoredAt: z.string().datetime(),
});

export type JobTargetScoredPayload = z.infer<typeof jobTargetScoredV1Schema>;

/**
 * Emitted in the transaction that accepts an interview answer. `stateVersion` is the session
 * version at which the answer was accepted (state SCORING); the interview-score job needs
 * exactly these three fields.
 */
export const interviewTurnAnsweredV1Schema = z.object({
  sessionId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  turnIndex: z.number().int().min(0).max(4),
  stateVersion: z.number().int().nonnegative(),
});

export type InterviewTurnAnsweredPayload = z.infer<typeof interviewTurnAnsweredV1Schema>;

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
export type JobTargetSubmittedEvent = DomainEventEnvelope<'jobtarget.submitted', JobTargetSubmittedPayload>;
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
