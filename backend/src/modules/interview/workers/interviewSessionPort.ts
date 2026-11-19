// src/modules/interview/workers/interviewSessionPort.ts
//
// The only thing the interview-score worker knows about storage. The InterviewSession
// model and service are a separate piece of work; when they land, one adapter implementing
// this interface over that model is all the worker needs. Field names and value sets
// mirror frontend/src/services/interviewService.ts.
import type {
  InterviewMode,
  InterviewScorecard,
  InterviewState,
  InterviewStatus,
} from '../interview.types.js';
import type { InterviewRole, Question } from '../questionBank/index.js';

export interface ScoringTurn {
  /** The planned question for this turn, including its checklist and hints. */
  question: Question;
  answer: string | null;
  /** Interviewer reply stored for the turn, if one was already written. */
  feedback: string | null;
  /** Submitted source, when collected by the session service. Never inferred from feedback. */
  code?: string | null;
}

/** Read-only view of a session, as much of it as scoring needs. */
export interface ScoringSession {
  id: string;
  userId: string;
  role: InterviewRole;
  status: InterviewStatus;
  state: InterviewState;
  /** Bumped by every state change; the optimistic-concurrency token. */
  stateVersion: number;
  currentTurnIndex: number;
  /** Planned length of the interview (the UI allows up to 5). */
  totalTurns: number;
  /** `basic_mode` once any turn fell back to checklist scoring. Absent means `ai`. */
  mode?: InterviewMode;
  /** Planned and answered turns so far, index = turn index. */
  turns: ScoringTurn[];
  /** Actual elapsed duration, if recorded by the session service. */
  durationSeconds?: number | null;
}

export interface TurnGuard {
  sessionId: string;
  turnIndex: number;
  /** The session version the result was computed against. */
  expectedStateVersion: number;
}

export interface TurnResult extends TurnGuard {
  /** Interviewer reply to store on the turn. */
  feedback: string;
  /** `basic_mode` flags the whole session; `ai` leaves an existing flag alone. */
  mode: InterviewMode;
  /** Model that produced the reply, or the checklist scorer's name. */
  model: string;
  promptVersion: string;
}

export interface FinalResult extends TurnResult {
  scorecard: InterviewScorecard;
}

/** `stale` means nothing was written because the session moved on. */
export type CommitResult = 'applied' | 'stale';

export interface InterviewSessionPort {
  load(sessionId: string): Promise<ScoringSession | null>;

  /**
   * Store the reply of a non-final turn and move the session forward.
   *
   * Must be one atomic compare-and-set: apply only if the session is still `in_progress`,
   * in state SCORING, on `turnIndex`, with `stateVersion === expectedStateVersion`, and bump
   * the version in the same write. Return `stale` without writing anything otherwise.
   */
  commitTurnResult(result: TurnResult): Promise<CommitResult>;

  /**
   * Same guard as commitTurnResult; also stores the scorecard and completes the session.
   * The production adapter should stageInterviewEvaluation(completedEvaluationInput(snapshot), transaction)
   * in this same transaction. The score worker's post-commit enqueue/retry is a backup, not an atomic outbox.
   */
  commitFinalResult(result: FinalResult): Promise<CommitResult>;
}
