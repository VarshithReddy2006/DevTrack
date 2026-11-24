// src/modules/interview/interviewSession.port.ts
//
// Mongoose adapter for the InterviewSessionPort the interview-score worker talks to.
// Both commit methods are single compare-and-set updates on stateVersion, so a result that
// was computed for an older version of the session is dropped without writing anything.
import { Types, type Model } from 'mongoose';
import { InterviewSession, type IInterviewSession } from '../../db/models/interviewSession.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { transitionPath } from './stateMachine.js';
import { completedEvaluationInput, stageInterviewEvaluation } from './workers/interviewEvaluate.worker.js';
import type {
  CommitResult,
  FinalResult,
  InterviewSessionPort,
  ScoringSession,
  TurnResult,
} from './workers/interviewSessionPort.js';

type SessionFields = Pick<
  IInterviewSession,
  'userId' | 'role' | 'status' | 'state' | 'stateVersion' | 'currentTurnIndex' | 'totalTurns' | 'mode' | 'durationSeconds' | 'turns'
> & { _id: unknown };

export function toScoringSession(doc: SessionFields): ScoringSession {
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    role: doc.role,
    status: doc.status,
    state: doc.state,
    stateVersion: doc.stateVersion,
    currentTurnIndex: doc.currentTurnIndex,
    totalTurns: doc.totalTurns,
    mode: doc.mode,
    durationSeconds: doc.durationSeconds ?? null,
    turns: doc.turns.map((turn) => ({
      question: turn.question,
      answer: turn.answer ?? null,
      feedback: turn.feedback ?? null,
      code: turn.code ?? null,
    })),
  };
}

export function createMongoInterviewSessionPort(
  model: Model<IInterviewSession> = InterviewSession,
  now: () => Date = () => new Date(),
): InterviewSessionPort {
  /** Same guard for both commits: still in_progress, SCORING, that turn, that version. */
  const guard = (result: TurnResult, lastTurn: boolean) => {
    const turnIndex = result.turnIndex;
    return {
      _id: new Types.ObjectId(result.sessionId),
      status: 'in_progress',
      state: 'SCORING',
      currentTurnIndex: turnIndex,
      stateVersion: result.expectedStateVersion,
      // The turn must hold an answer. $expr, because a dotted `turns.N.answer` filter also matches a
      // field named "N" inside every element (see InterviewService.submitAnswer).
      $expr: {
        $and: [
          { $ne: [{ $arrayElemAt: ['$turns.answer', turnIndex] }, null] },
          lastTurn
            ? { $eq: ['$currentTurnIndex', { $subtract: ['$totalTurns', 1] }] }
            : { $lt: ['$currentTurnIndex', { $subtract: ['$totalTurns', 1] }] },
        ],
      },
    };
  };

  const common = (result: TurnResult) => ({
    [`turns.${result.turnIndex}.feedback`]: result.feedback,
    scoringModel: result.model,
    promptVersion: result.promptVersion,
    lastActivityAt: now(),
    ...(result.mode === 'basic_mode' ? { mode: 'basic_mode' } : {}),
  });

  return {
    async load(sessionId) {
      if (!Types.ObjectId.isValid(sessionId)) return null;
      const doc = await model.findById(sessionId).lean();
      return doc ? toScoringSession(doc) : null;
    },

    async commitTurnResult(result: TurnResult): Promise<CommitResult> {
      // SCORING -> NEXT_QUESTION -> QUESTION_PENDING in one write, so a scored turn never
      // rests in NEXT_QUESTION and the version moves by one.
      const state = transitionPath('SCORING', ['SCORED_NEXT', 'ADVANCE']);
      const updated = await model.findOneAndUpdate(
        guard(result, false),
        { $set: { ...common(result), state }, $inc: { stateVersion: 1, currentTurnIndex: 1 } },
        { new: true },
      ).lean();
      return updated ? 'applied' : 'stale';
    },

    async commitFinalResult(result: FinalResult): Promise<CommitResult> {
      const state = transitionPath('SCORING', ['SCORED_FINAL', 'COMPLETE']);
      const closedAt = now();
      return runInTransaction(async (session) => {
        const updated = await model.findOneAndUpdate(
          guard(result, true),
          {
            $set: {
              ...common(result), state, status: 'completed', scorecard: result.scorecard,
              closedAt, 'guard.warningPending': false,
            },
            $inc: { stateVersion: 1 },
          },
          { new: true, session },
        ).lean();
        if (!updated) return 'stale';
        const durationSeconds = Math.max(0, Math.round((closedAt.getTime() - updated.startedAt.getTime()) / 1000));
        await model.updateOne({ _id: updated._id }, { $set: { durationSeconds } }, { session });
        // The evaluation request commits or rolls back together with the final result.
        await stageInterviewEvaluation(
          completedEvaluationInput({ ...toScoringSession(updated), durationSeconds }),
          session,
        );
        return 'applied';
      });
    },
  };
}

