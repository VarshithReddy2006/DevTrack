// src/modules/interview/interview.service.ts
//
// Session lifecycle for the AI mock interview. Every mutation is one compare-and-set update
// keyed on { _id, userId, stateVersion } that also moves the state and bumps stateVersion, so
// two requests that race (a double submit, an answer sent while a hint is being processed)
// can never both win: the loser gets HTTP 409 and the session is left exactly as the winner
// wrote it. Legality of each move comes from stateMachine.ts.
import { Types, type Model } from 'mongoose';
import { InterviewSession, type IInterviewSession, type IInterviewTurn } from '../../db/models/interviewSession.model.js';
import { writeOutboxEvent } from '../../shared/events/outbox.js';
import type { InterviewTurnAnsweredPayload } from '../../shared/events/eventContract.js';
import type { InterviewScorecard } from './interview.types.js';
import type { GuardedInterviewSession } from './interviewGuard.schema.js';
import { InterviewGuardError, InterviewGuardService } from './interviewGuard.service.js';
import { createMongoInterviewSessionPort } from './interviewSession.port.js';
import { selectQuestionsForInterview, type InterviewRole } from './questionBank/index.js';
import {
  IllegalTransitionError,
  InterviewError,
  StateVersionConflictError,
  assertOpen,
  assertStateVersion,
  canTransition,
  transition,
  type InterviewEvent,
} from './stateMachine.js';
import { enqueueCompletedInterview } from './workers/interviewEvaluate.worker.js';

/** An in-progress interview nobody touched for this long is closed as abandoned by the sweep. */
export const INTERVIEW_ABANDON_AFTER_MS = 24 * 60 * 60_000;

export const TURN_ANSWERED_EVENT = 'interview.turn.answered';
const TURN_ANSWERED_AGGREGATE = 'interview_session';

/** What the studio UI sees. The checklist and unrevealed hints never leave the server. */
export interface InterviewTurnView {
  question: { prompt: string };
  answer: string | null;
  feedback: string | null;
  hints: string[];
  hintsRemaining: number;
}

export interface InterviewSessionView {
  id: string;
  role: InterviewRole;
  status: IInterviewSession['status'];
  state: IInterviewSession['state'];
  stateVersion: number;
  currentTurnIndex: number;
  totalTurns: number;
  turns: InterviewTurnView[];
  scorecard: InterviewScorecard | null;
  mode: IInterviewSession['mode'];
}

type SessionRecord = Pick<
  IInterviewSession,
  'role' | 'status' | 'state' | 'stateVersion' | 'currentTurnIndex' | 'totalTurns' | 'turns' | 'scorecard' | 'mode'
> & { _id: unknown };

/** Questions after the current one stay hidden, so a client cannot read ahead. */
export function toSessionView(doc: SessionRecord): InterviewSessionView {
  const visible: IInterviewTurn[] = doc.turns.slice(0, doc.currentTurnIndex + 1);
  return {
    id: String(doc._id),
    role: doc.role,
    status: doc.status,
    state: doc.state,
    stateVersion: doc.stateVersion,
    currentTurnIndex: doc.currentTurnIndex,
    totalTurns: doc.totalTurns,
    turns: visible.map((turn) => ({
      question: { prompt: turn.question.prompt },
      answer: turn.answer ?? null,
      feedback: turn.feedback ?? null,
      hints: (turn.hints ?? []).map((hint) => hint.text),
      hintsRemaining: Math.max(0, turn.question.hints.length - (turn.hints ?? []).length),
    })),
    scorecard: doc.scorecard ?? null,
    mode: doc.mode,
  };
}

export class OpenSessionExistsError extends InterviewError {
  constructor(public readonly session: InterviewSessionView) {
    super('interview_session_open', 409, 'You already have an interview in progress. Resume or finish it first.', { session });
    this.name = 'OpenSessionExistsError';
  }
}

const sessionNotFound = () => new InterviewError('session_not_found', 404, 'Interview session not found');

const GUARD_MESSAGES: Record<string, string> = {
  session_not_found: 'Interview session not found',
  session_completed: 'The interview is already completed.',
  session_abandoned: 'The interview was abandoned.',
  session_expired: 'The interview expired after a period of inactivity.',
  session_timeout: 'The 45 minute interview time limit has passed.',
  turn_limit_reached: 'All questions of this interview were already answered.',
  state_version_conflict: 'The interview moved on since you loaded it. Reload the session and try again.',
  turn_not_allowed: 'An answer cannot be submitted in the current state of the interview.',
};

function translateGuardError(error: unknown): unknown {
  if (!(error instanceof InterviewGuardError)) return error;
  return new InterviewError(error.code, error.statusCode, GUARD_MESSAGES[error.code] ?? error.code);
}

export interface InterviewServiceDeps {
  model?: Model<IInterviewSession>;
  now?: () => Date;
  /** Question plan for a new session. Defaults to the curated bank. */
  selectQuestions?: typeof selectQuestionsForInterview;
  /** Durable hand-off of a completed session to the rubric evaluator (used by the timeout guard). */
  evaluateCompleted?: ConstructorParameters<typeof InterviewGuardService>[1]['evaluateCompleted'];
}

export class InterviewService {
  private readonly model: Model<IInterviewSession>;
  private readonly now: () => Date;
  private readonly selectQuestions: typeof selectQuestionsForInterview;
  readonly guard: InterviewGuardService;

  constructor(deps: InterviewServiceDeps = {}) {
    this.model = deps.model ?? InterviewSession;
    this.now = deps.now ?? (() => new Date());
    this.selectQuestions = deps.selectQuestions ?? selectQuestionsForInterview;
    const port = createMongoInterviewSessionPort(this.model, this.now);
    this.guard = new InterviewGuardService(this.model as unknown as Model<GuardedInterviewSession>, {
      now: this.now,
      evaluateCompleted: deps.evaluateCompleted ?? (async (session) => {
        const snapshot = await port.load(String(session._id));
        if (!snapshot) throw new Error('Completed interview snapshot is missing');
        await enqueueCompletedInterview(snapshot);
      }),
    });
  }

  /** Start an interview. A user with an open session gets a 409 that carries that session. */
  async createSession(userId: string, role: InterviewRole, options: { gaps?: readonly string[] } = {}): Promise<InterviewSessionView> {
    await this.reconcileOpen(userId);
    const open = await this.findOpen(userId);
    if (open) throw new OpenSessionExistsError(toSessionView(open));

    const questions = this.selectQuestions(role, options.gaps ?? []);
    if (questions.length === 0) throw new InterviewError('no_questions', 500, `No interview questions are available for ${role}.`);

    const now = this.now();
    try {
      const created = await this.model.create({
        userId,
        role,
        state: transition('START', 'BEGIN'),
        // START is version 0; the BEGIN move makes it 1.
        stateVersion: 1,
        totalTurns: questions.length,
        maxTurns: questions.length,
        startedAt: now,
        lastActivityAt: now,
        turns: questions.map((question) => ({ question, answer: null, code: null, hints: [], feedback: null, answeredAt: null })),
      });
      return toSessionView(created.toObject());
    } catch (error) {
      // Two start requests raced: the partial unique index let only one through.
      if ((error as { code?: number }).code === 11000) {
        const winner = await this.findOpen(userId);
        if (winner) throw new OpenSessionExistsError(toSessionView(winner));
      }
      throw error;
    }
  }

  /** The open session to resume after a reconnect, or null. */
  async getCurrentSession(userId: string): Promise<InterviewSessionView | null> {
    await this.reconcileOpen(userId);
    const open = await this.findOpen(userId);
    return open ? toSessionView(open) : null;
  }

  async getSession(userId: string, sessionId: string): Promise<InterviewSessionView> {
    const id = this.parseId(sessionId);
    await this.guard.reconcile(id, userId);
    const session = await this.model.findOne({ _id: id, userId }).lean();
    if (!session) throw sessionNotFound();
    return toSessionView(session);
  }

  /**
   * Accept the answer to the current question. The guard reserves the turn with a compare-and-set
   * on stateVersion and, in the same MongoDB transaction, this writes the answer and the
   * `interview.turn.answered` outbox event. Returns the session in state SCORING.
   */
  async submitAnswer(
    userId: string,
    sessionId: string,
    input: { turnIndex: number; answer: string; code?: string | null; stateVersion: number },
  ): Promise<InterviewSessionView> {
    const id = this.parseId(sessionId);
    await this.guard.reconcile(id, userId);
    const current = await this.model.findOne({ _id: id, userId }).lean();
    if (!current) throw sessionNotFound();
    this.assertCanApply(current, 'SUBMIT_ANSWER', input.stateVersion);
    this.assertCurrentTurn(current, input.turnIndex);

    try {
      return await this.guard.acceptTurn({ sessionId: id, userId, stateVersion: input.stateVersion }, async (accepted, transaction) => {
        const path = `turns.${input.turnIndex}`;
        const written = await this.model.updateOne(
          // $expr, not `turns.N.answer: null`: a dotted path with an index also matches a field named
          // "N" inside every element, which is missing and so always counts as null.
          { _id: accepted._id, $expr: { $eq: [{ $arrayElemAt: ['$turns.answer', input.turnIndex] }, null] } },
          { $set: { [`${path}.answer`]: input.answer, [`${path}.code`]: input.code ?? null, [`${path}.answeredAt`]: this.now() } },
          { session: transaction },
        );
        if (written.matchedCount !== 1) {
          throw new InterviewError('turn_already_answered', 409, `Question ${input.turnIndex + 1} already has an answer.`);
        }
        const payload: InterviewTurnAnsweredPayload = {
          sessionId: id, turnIndex: input.turnIndex, stateVersion: accepted.stateVersion,
        };
        await writeOutboxEvent(transaction, {
          type: TURN_ANSWERED_EVENT,
          aggregateType: TURN_ANSWERED_AGGREGATE,
          aggregateId: id,
          userId,
          payload,
        });
        const fresh = await this.model.findById(accepted._id).session(transaction).lean();
        if (!fresh) throw sessionNotFound();
        return toSessionView(fresh);
      });
    } catch (error) {
      throw translateGuardError(error);
    }
  }

  /** Reveal the next hint of the current question. Counts as a state mutation (version + 1). */
  async requestHint(
    userId: string,
    sessionId: string,
    input: { turnIndex: number; stateVersion: number },
  ): Promise<InterviewSessionView> {
    const id = this.parseId(sessionId);
    await this.guard.reconcile(id, userId);
    const current = await this.model.findOne({ _id: id, userId }).lean();
    if (!current) throw sessionNotFound();
    this.assertCanApply(current, 'REQUEST_HINT', input.stateVersion);
    this.assertCurrentTurn(current, input.turnIndex);

    const turn = current.turns[input.turnIndex]!;
    const given = turn.hints?.length ?? 0;
    const text = turn.question.hints[given];
    if (text === undefined) {
      throw new InterviewError('no_hints_remaining', 409, 'All hints for this question were already used.');
    }

    const updated = await this.model.findOneAndUpdate(
      {
        _id: id, userId, status: 'in_progress', state: 'QUESTION_PENDING',
        stateVersion: input.stateVersion, currentTurnIndex: input.turnIndex,
      },
      {
        $push: { [`turns.${input.turnIndex}.hints`]: { index: given, text, requestedAt: this.now() } },
        $set: { state: transition('QUESTION_PENDING', 'REQUEST_HINT'), lastActivityAt: this.now() },
        $inc: { stateVersion: 1 },
      },
      { new: true },
    ).lean();
    if (!updated) throw await this.explainLostRace(id, userId, 'REQUEST_HINT', input.stateVersion, input.turnIndex);
    return toSessionView(updated);
  }

  /**
   * Leave an interview early and free the one-open-session slot. A session that is already
   * closed is returned unchanged, so retrying a finish request is harmless.
   */
  async finishSession(userId: string, sessionId: string, input: { stateVersion: number }): Promise<InterviewSessionView> {
    const id = this.parseId(sessionId);
    await this.guard.reconcile(id, userId);
    const current = await this.model.findOne({ _id: id, userId }).lean();
    if (!current) throw sessionNotFound();
    if (current.status !== 'in_progress') return toSessionView(current);
    this.assertCanApply(current, 'ABANDON', input.stateVersion);

    const now = this.now();
    const updated = await this.model.findOneAndUpdate(
      { _id: id, userId, status: 'in_progress', state: current.state, stateVersion: input.stateVersion },
      {
        $set: {
          status: 'abandoned', state: transition(current.state, 'ABANDON'), closedAt: now,
          lastActivityAt: now, 'guard.warningPending': false,
        },
        $inc: { stateVersion: 1 },
      },
      { new: true },
    ).lean();
    if (!updated) throw await this.explainLostRace(id, userId, 'ABANDON', input.stateVersion);
    return toSessionView(updated);
  }

  /**
   * Close every in-progress session nobody touched for 24 hours as `abandoned`. This also frees
   * the owner's open slot. It bumps stateVersion, so a scoring result still in flight is dropped.
   * Returns how many sessions were closed.
   */
  async abandonStaleSessions(): Promise<number> {
    return this.closeStale({});
  }

  private async closeStale(scope: { userId?: string }): Promise<number> {
    const now = this.now();
    const result = await this.model.updateMany(
      { ...scope, status: 'in_progress', lastActivityAt: { $lt: new Date(now.getTime() - INTERVIEW_ABANDON_AFTER_MS) } },
      {
        $set: {
          // SWEEP leads to COMPLETED from every open state.
          status: 'abandoned', state: 'COMPLETED', closedAt: now,
          'guard.reason': 'inactive', 'guard.warningPending': false, 'guard.evaluationPending': false,
        },
        $inc: { stateVersion: 1 },
      },
    );
    return result.modifiedCount;
  }

  /** One maintenance pass: 24 hour abandonment first, then the guard's timeout/inactivity rules. */
  async sweep(): Promise<void> {
    await this.abandonStaleSessions();
    await this.guard.sweep();
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private parseId(value: string): string {
    if (!Types.ObjectId.isValid(value) || String(new Types.ObjectId(value)) !== value.toLowerCase()) throw sessionNotFound();
    return value;
  }

  private findOpen(userId: string) {
    return this.model.findOne({ userId, isOpen: true }).lean();
  }

  /** Apply the 24 hour abandonment and the guard's deadlines to this user's open session, if any. */
  private async reconcileOpen(userId: string): Promise<void> {
    const open = await this.model.findOne({ userId, isOpen: true }).select({ lastActivityAt: 1 }).lean();
    if (!open) return;
    const cutoff = new Date(this.now().getTime() - INTERVIEW_ABANDON_AFTER_MS);
    if (open.lastActivityAt < cutoff) await this.closeStale({ userId });
    else await this.guard.reconcile(String(open._id), userId);
  }

  /** Status, version and transition checks, in that order, each with its own 409. */
  private assertCanApply(session: SessionRecord & { status: IInterviewSession['status'] }, event: InterviewEvent, expectedVersion: number): void {
    assertOpen(session.status);
    assertStateVersion(expectedVersion, session.stateVersion);
    transition(session.state, event);
  }

  private assertCurrentTurn(session: SessionRecord, turnIndex: number): void {
    if (turnIndex !== session.currentTurnIndex) {
      throw new InterviewError(
        'turn_mismatch', 409,
        `Question ${turnIndex + 1} is not the current question (the interview is on question ${session.currentTurnIndex + 1}).`,
      );
    }
  }

  /** The compare-and-set matched nothing: read the row again and say why. */
  private async explainLostRace(
    id: string,
    userId: string,
    event: InterviewEvent,
    expectedVersion: number,
    expectedTurnIndex?: number,
  ): Promise<InterviewError> {
    const latest = await this.model.findOne({ _id: id, userId }).lean();
    if (!latest) return sessionNotFound();
    try {
      assertOpen(latest.status);
      if (expectedTurnIndex !== undefined && latest.currentTurnIndex !== expectedTurnIndex) {
        this.assertCurrentTurn(latest, expectedTurnIndex);
      }
      assertStateVersion(expectedVersion, latest.stateVersion);
      if (!canTransition(latest.state, event)) transition(latest.state, event);
    } catch (error) {
      if (error instanceof StateVersionConflictError) return error;
      if (error instanceof IllegalTransitionError) {
        if (latest.stateVersion !== expectedVersion) {
          return new StateVersionConflictError(expectedVersion, latest.stateVersion);
        }
        return error;
      }
      if (error instanceof InterviewError) return error;
      throw error;
    }
    return new StateVersionConflictError(expectedVersion, latest.stateVersion);
  }
}

let defaultService: InterviewService | null = null;
export function getInterviewService(): InterviewService {
  return (defaultService ??= new InterviewService());
}
