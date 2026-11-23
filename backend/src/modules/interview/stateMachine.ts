// src/modules/interview/stateMachine.ts
//
// The server-side state machine of a mock interview. Pure functions only: no database,
// no clock. The service decides what to write, this file decides whether a move is legal.
//
//   START -> QUESTION_PENDING -> SCORING -> NEXT_QUESTION -> QUESTION_PENDING ...
//                                       \-> FINAL_SCORECARD -> COMPLETED
//
// Every accepted move bumps `stateVersion` by exactly one, in the same write as the new
// state. That version is the optimistic lock: a client (or a scoring job) that acts on an
// older version is rejected with HTTP 409 instead of being applied on top of newer state.
import type { InterviewState, InterviewStatus } from './interview.types.js';

export const INTERVIEW_EVENTS = [
  /** A new session gets its first question. */
  'BEGIN',
  /** The candidate submits the answer to the current question. */
  'SUBMIT_ANSWER',
  /** The candidate asks for the next hint of the current question. */
  'REQUEST_HINT',
  /** A non-final answer was scored. */
  'SCORED_NEXT',
  /** The last answer was scored and the scorecard is ready. */
  'SCORED_FINAL',
  /** The next question becomes the current one. */
  'ADVANCE',
  /** The scorecard has been stored and the session is closed. */
  'COMPLETE',
  /** The candidate leaves early. Not allowed while an answer is being scored. */
  'ABANDON',
  /** The system closes a session (inactivity sweep). Allowed from any open state. */
  'SWEEP',
] as const;
export type InterviewEvent = (typeof INTERVIEW_EVENTS)[number];

const TRANSITIONS: Record<InterviewState, Partial<Record<InterviewEvent, InterviewState>>> = {
  START: { BEGIN: 'QUESTION_PENDING', ABANDON: 'COMPLETED', SWEEP: 'COMPLETED' },
  QUESTION_PENDING: {
    SUBMIT_ANSWER: 'SCORING',
    REQUEST_HINT: 'QUESTION_PENDING',
    ABANDON: 'COMPLETED',
    SWEEP: 'COMPLETED',
  },
  SCORING: { SCORED_NEXT: 'NEXT_QUESTION', SCORED_FINAL: 'FINAL_SCORECARD', SWEEP: 'COMPLETED' },
  NEXT_QUESTION: { ADVANCE: 'QUESTION_PENDING', ABANDON: 'COMPLETED', SWEEP: 'COMPLETED' },
  FINAL_SCORECARD: { COMPLETE: 'COMPLETED', SWEEP: 'COMPLETED' },
  COMPLETED: {},
};

/** Base class for every error the interview module raises on purpose. */
export class InterviewError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'InterviewError';
  }
}

export class IllegalTransitionError extends InterviewError {
  constructor(public readonly state: InterviewState, public readonly event: InterviewEvent) {
    const allowed = allowedEvents(state);
    super(
      'illegal_state_transition',
      409,
      `Cannot apply ${event} while the interview is in state ${state}. ` +
        (allowed.length ? `Allowed events: ${allowed.join(', ')}.` : 'The interview is already finished.'),
    );
    this.name = 'IllegalTransitionError';
  }
}

export class StateVersionConflictError extends InterviewError {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(
      'state_version_conflict',
      409,
      `The interview moved on (stateVersion is ${actual}, the request used ${expected}). Reload the session and try again.`,
    );
    this.name = 'StateVersionConflictError';
  }
}

export function allowedEvents(state: InterviewState): InterviewEvent[] {
  return Object.keys(TRANSITIONS[state]) as InterviewEvent[];
}

export function canTransition(state: InterviewState, event: InterviewEvent): boolean {
  return TRANSITIONS[state]?.[event] !== undefined;
}

/** The state `event` leads to, or an IllegalTransitionError that names the allowed events. */
export function transition(state: InterviewState, event: InterviewEvent): InterviewState {
  const next = TRANSITIONS[state]?.[event];
  if (next === undefined) throw new IllegalTransitionError(state, event);
  return next;
}

/**
 * Apply several events in order, validating each step. Used where one atomic write covers more
 * than one hop (for example SCORED_NEXT then ADVANCE, so a scored turn is never left resting in
 * NEXT_QUESTION). Returns the final state.
 */
export function transitionPath(state: InterviewState, events: readonly InterviewEvent[]): InterviewState {
  return events.reduce<InterviewState>((current, event) => transition(current, event), state);
}

export function isTerminalState(state: InterviewState): boolean {
  return allowedEvents(state).length === 0;
}

/**
 * The optimistic lock. Throws a 409 unless the version the client saw is still the current one.
 * Callers that update the database must repeat this check inside the write filter; this helper
 * only gives the early, descriptive answer.
 */
export function assertStateVersion(expected: number, actual: number): void {
  if (expected !== actual) throw new StateVersionConflictError(expected, actual);
}

/** Only a session that is `in_progress` may move; every other status is final. */
export function assertOpen(status: InterviewStatus): void {
  if (status !== 'in_progress') {
    throw new InterviewError('session_closed', 409, `The interview is ${status} and cannot change any more.`);
  }
}
