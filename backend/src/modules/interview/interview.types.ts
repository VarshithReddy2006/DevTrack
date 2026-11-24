// src/modules/interview/interview.types.ts
//
// Shapes the interview-score worker shares with the (separate) InterviewSession service.
// They mirror what the studio UI already consumes in
// frontend/src/services/interviewService.ts, so a session persisted by the service
// can be handed to the worker and a scorecard written by the worker renders as is.
// The Mongoose model is db/models/interviewSession.model.ts; the routes are interview.routes.ts.

export const INTERVIEW_STATUSES = ['in_progress', 'completed', 'abandoned', 'expired'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const INTERVIEW_STATES = [
  'START',
  'QUESTION_PENDING',
  'SCORING',
  'NEXT_QUESTION',
  'FINAL_SCORECARD',
  'COMPLETED',
] as const;
export type InterviewState = (typeof INTERVIEW_STATES)[number];

/** `basic_mode` means checklist scoring was used instead of the model (Guardrail G8). */
export type InterviewMode = 'ai' | 'basic_mode';

export const RUBRIC_DIMENSIONS = [
  'problemBreakdown',
  'technicalTradeoffs',
  'edgeCases',
  'communication',
] as const;
export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

export const RUBRIC_DIMENSION_LABELS: Record<RubricDimension, string> = {
  problemBreakdown: 'Problem breakdown and scoping',
  technicalTradeoffs: 'Technical trade-offs and architecture',
  edgeCases: 'Edge cases and reliability',
  communication: 'Technical communication clarity',
};

export interface InterviewScorecard {
  /** Each 0 to 100. */
  scores: Record<RubricDimension, number>;
  strengths: string[];
  improvements: string[];
}

/** Upper bounds shared by the model parser and the checklist scorer so both stay UI friendly. */
export const MAX_SCORECARD_ITEMS = 5;
export const MAX_SCORECARD_ITEM_LENGTH = 300;
