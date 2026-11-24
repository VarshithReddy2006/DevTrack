// src/db/models/interviewSession.model.ts — one AI mock interview (5 questions) per document.
//
// The document is only ever changed through compare-and-set updates on `stateVersion`
// (see modules/interview/interview.service.ts and stateMachine.ts). `isOpen` is true exactly
// while status is `in_progress`; a partial unique index on { userId, isOpen } then allows one
// open interview per user and none of the closed ones count.
import mongoose, { Schema, type Document, type Model, type Query, type UpdateQuery } from 'mongoose';
import {
  INTERVIEW_STATES,
  INTERVIEW_STATUSES,
  type InterviewMode,
  type InterviewScorecard,
  type InterviewState,
  type InterviewStatus,
} from '../../modules/interview/interview.types.js';
import { addInterviewGuardFields, type GuardedInterviewSession } from '../../modules/interview/interviewGuard.schema.js';
import { INTERVIEW_ROLES, type InterviewRole, type Question } from '../../modules/interview/questionBank/index.js';
import { INTERVIEW_SESSION_INDEXES } from './interviewSessionIndexes.js';

export const INTERVIEW_TOTAL_TURNS = 5;
/** How long a session row is kept after it was last written (TTL on retainUntil). */
export const INTERVIEW_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const INTERVIEW_ANSWER_MAX_LENGTH = 8_000;

export interface IInterviewHint {
  /** Zero-based position in the question's progressive hint list. */
  index: number;
  text: string;
  requestedAt: Date;
}

export interface IInterviewTurn {
  /** Snapshot of the planned question, with its hints and checklist. Never sent to clients as is. */
  question: Question;
  answer: string | null;
  code: string | null;
  hints: IInterviewHint[];
  feedback: string | null;
  answeredAt: Date | null;
}

export interface IInterviewSession extends Document, Omit<GuardedInterviewSession, '_id'> {
  role: InterviewRole;
  status: InterviewStatus;
  state: InterviewState;
  stateVersion: number;
  currentTurnIndex: number;
  totalTurns: number;
  turns: IInterviewTurn[];
  mode: InterviewMode;
  scorecard: InterviewScorecard | null;
  scoringModel: string | null;
  promptVersion: string | null;
  durationSeconds: number | null;
  isOpen: boolean;
  retainUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

const hintSchema = new Schema<IInterviewHint>(
  {
    index: { type: Number, required: true, min: 0, validate: Number.isInteger },
    text: { type: String, required: true },
    requestedAt: { type: Date, required: true },
  },
  { _id: false },
);

const turnSchema = new Schema<IInterviewTurn>(
  {
    question: { type: Schema.Types.Mixed, required: true },
    answer: { type: String, default: null, maxlength: INTERVIEW_ANSWER_MAX_LENGTH },
    code: { type: String, default: null },
    hints: { type: [hintSchema], default: [] },
    feedback: { type: String, default: null },
    answeredAt: { type: Date, default: null },
  },
  { _id: false, minimize: false },
);

const interviewSessionSchema = new Schema<IInterviewSession>(
  {
    userId: { type: String, required: true },
    role: { type: String, required: true, enum: INTERVIEW_ROLES },
    status: { type: String, required: true, enum: INTERVIEW_STATUSES, default: 'in_progress' },
    state: { type: String, required: true, enum: INTERVIEW_STATES, default: 'START' },
    // Monotonic. Incremented by exactly one on every state mutation.
    stateVersion: { type: Number, required: true, default: 0, min: 0, validate: Number.isInteger },
    currentTurnIndex: { type: Number, required: true, default: 0, min: 0, max: INTERVIEW_TOTAL_TURNS - 1, validate: Number.isInteger },
    totalTurns: { type: Number, required: true, default: INTERVIEW_TOTAL_TURNS, min: 1, max: INTERVIEW_TOTAL_TURNS, validate: Number.isInteger },
    turns: {
      type: [turnSchema],
      default: [],
      validate: { validator: (turns: unknown[]) => turns.length <= INTERVIEW_TOTAL_TURNS, message: 'An interview has at most 5 turns' },
    },
    mode: { type: String, enum: ['ai', 'basic_mode'], default: 'ai' },
    scorecard: { type: Schema.Types.Mixed, default: null },
    scoringModel: { type: String, default: null },
    promptVersion: { type: String, default: null },
    durationSeconds: { type: Number, default: null, min: 0 },
    isOpen: { type: Boolean, required: true, default: true },
    retainUntil: { type: Date, required: true, default: () => new Date(Date.now() + INTERVIEW_RETENTION_MS) },
  },
  { timestamps: true, minimize: false },
);

// startedAt, lastActivityAt, turnsCount, maxTurns, closedAt and the guard sub-document.
addInterviewGuardFields(interviewSessionSchema);

// The guard's own indexes come from addInterviewGuardFields above.
for (const { key, options } of INTERVIEW_SESSION_INDEXES) interviewSessionSchema.index(key, options);

// Keep isOpen and retainUntil in step with status, whoever closes the session (the service,
// the lifecycle guard's atomic updates, the scoring port): any update that sets a status other
// than in_progress also clears isOpen, so the one-open-session slot is released with it.
function releaseOpenSlot(this: Query<unknown, IInterviewSession>) {
  const update = this.getUpdate() as UpdateQuery<IInterviewSession> | null;
  if (!update || Array.isArray(update)) return;
  const status = update.$set?.status;
  if (typeof status === 'string' && status !== 'in_progress') {
    this.setUpdate({
      ...update,
      $set: { ...update.$set, isOpen: false, retainUntil: new Date(Date.now() + INTERVIEW_RETENTION_MS) },
    });
  }
}
interviewSessionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], releaseOpenSlot);
interviewSessionSchema.pre('save', function () {
  if (this.status !== 'in_progress') this.isOpen = false;
});

export const InterviewSession: Model<IInterviewSession> =
  (mongoose.models.InterviewSession as Model<IInterviewSession> | undefined) ??
  mongoose.model<IInterviewSession>('InterviewSession', interviewSessionSchema);
