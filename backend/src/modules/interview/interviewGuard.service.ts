import { randomUUID } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { z } from 'zod';
import { eventBus } from '../../shared/sse/eventBus.js';
import {
  INTERVIEW_INACTIVE_MS, INTERVIEW_TIMEOUT_MS, INTERVIEW_WARNING_MS, MAX_INTERVIEW_TURNS,
  type GuardedInterviewSession,
} from './interviewGuard.schema.js';

export class InterviewGuardError extends Error {
  constructor(public code: string, public statusCode: number) { super(code); }
}
const turnRequestSchema = z.object({
  sessionId: z.string().regex(/^[a-f\d]{24}$/i),
  userId: z.string().min(1), stateVersion: z.number().int().nonnegative(),
}).strict();
export interface InterviewGuardDeps {
  /** Idempotently persist/queue evaluation of this completed session. Required; never silently dropped. */
  evaluateCompleted: (session: GuardedInterviewSession) => Promise<void>;
  warning?: (userId: string, payload: { sessionId: string; minutesRemaining: 5 }) => Promise<void>;
  now?: () => Date;
}

export class InterviewGuardService {
  private readonly now: () => Date;
  private readonly warning: NonNullable<InterviewGuardDeps['warning']>;
  constructor(private readonly sessions: Model<GuardedInterviewSession>, private readonly deps: InterviewGuardDeps) {
    if (typeof deps.evaluateCompleted !== 'function') throw new Error('Interview guard requires a durable evaluation adapter');
    for (const field of ['userId', 'status', 'state', 'stateVersion', 'startedAt', 'lastActivityAt', 'turnsCount', 'maxTurns', 'guard']) {
      if (!sessions.schema.path(field)) throw new Error(`Interview guard requires session field ${field}`);
    }
    this.now = deps.now ?? (() => new Date());
    this.warning = deps.warning ?? ((userId, payload) => eventBus.publishEnvelope(userId, 'interview.time_warning', payload));
  }

  /** Atomic lifecycle transitions invalidate in-flight scoring through stateVersion. Inactivity wins on late sweeps. */
  async reconcile(sessionId: string, userId?: string): Promise<void> {
    const now = this.now();
    const owner = { _id: sessionId, ...(userId ? { userId } : {}), status: 'in_progress' };
    const inactivityCutoff = new Date(now.getTime() - INTERVIEW_INACTIVE_MS);
    await this.sessions.updateOne({ ...owner, lastActivityAt: { $lt: inactivityCutoff } }, {
      $set: { status: 'expired', state: 'COMPLETED', closedAt: now, 'guard.reason': 'inactive', 'guard.warningPending': false },
      $inc: { stateVersion: 1 },
    });
    await this.sessions.updateOne({
      ...owner, startedAt: { $lte: new Date(now.getTime() - INTERVIEW_TIMEOUT_MS) },
      lastActivityAt: { $gte: inactivityCutoff },
    }, {
      $set: { status: 'completed', state: 'COMPLETED', closedAt: now, 'guard.reason': 'timeout', 'guard.warningPending': false, 'guard.evaluationPending': true },
      $inc: { stateVersion: 1 },
    });
    await this.sessions.updateOne({
      ...owner, startedAt: { $lte: new Date(now.getTime() - INTERVIEW_WARNING_MS), $gt: new Date(now.getTime() - INTERVIEW_TIMEOUT_MS) },
      'guard.warningAt': null,
    }, { $set: { 'guard.warningAt': now, 'guard.warningPending': true } });
  }

  /**
   * The owning route validates the answer first. Its callback writes the answer and transactional queue intent
   * using this MongoDB session. External side effects must stay outside the retryable transaction callback.
   */
  async acceptTurn<T>(value: z.infer<typeof turnRequestSchema>, writeAnswer: (session: GuardedInterviewSession, transaction: ClientSession) => Promise<T>): Promise<T> {
    const request = turnRequestSchema.parse(value);
    await this.reconcile(request.sessionId, request.userId);
    try {
      return await this.sessions.db.transaction(async transaction => {
        const now = this.now();
        const session = await this.sessions.findOneAndUpdate({
          _id: request.sessionId, userId: request.userId, status: 'in_progress', state: 'QUESTION_PENDING',
          stateVersion: request.stateVersion,
          startedAt: { $gt: new Date(now.getTime() - INTERVIEW_TIMEOUT_MS), $lte: now },
          lastActivityAt: { $gte: new Date(now.getTime() - INTERVIEW_INACTIVE_MS), $lte: now },
          $expr: { $lt: ['$turnsCount', { $min: ['$maxTurns', MAX_INTERVIEW_TURNS] }] },
        }, {
          $inc: { turnsCount: 1, stateVersion: 1 }, $set: { lastActivityAt: now, state: 'SCORING' },
        }, { new: true, session: transaction }).lean();
        if (!session) {
          const current = await this.sessions.findOne({ _id: request.sessionId, userId: request.userId }).session(transaction).lean();
          if (!current) throw new InterviewGuardError('session_not_found', 404);
          if (current.status !== 'in_progress') throw new InterviewGuardError(`session_${current.status}`, 400);
          if (current.startedAt.getTime() <= now.getTime() - INTERVIEW_TIMEOUT_MS) throw new InterviewGuardError('session_timeout', 400);
          if (current.turnsCount >= Math.min(current.maxTurns, MAX_INTERVIEW_TURNS)) throw new InterviewGuardError('turn_limit_reached', 400);
          if (current.stateVersion !== request.stateVersion) throw new InterviewGuardError('state_version_conflict', 409);
          throw new InterviewGuardError('turn_not_allowed', 409);
        }
        return writeAnswer(session, transaction);
      });
    } catch (error) {
      // Time can cross the deadline while a transaction is retried. Persist closure outside the aborted transaction.
      if (error instanceof InterviewGuardError && error.code === 'session_timeout') await this.reconcile(request.sessionId, request.userId);
      throw error;
    }
  }

  /** A database lease suppresses ordinary concurrent publications; stable session identity enables consumer dedup. */
  async deliver(sessionId: string): Promise<void> {
    const now = this.now();
    const token = randomUUID();
    const session = await this.sessions.findOneAndUpdate({
      _id: sessionId, 'guard.deliveryLeaseUntil': { $lte: now },
      $or: [{ 'guard.warningPending': true }, { 'guard.evaluationPending': true }],
    }, { $set: { 'guard.deliveryToken': token, 'guard.deliveryLeaseUntil': new Date(now.getTime() + 60_000) } }, { new: true }).lean();
    if (!session) return;
    const claim = { _id: sessionId, 'guard.deliveryToken': token };
    try {
      if (session.guard.warningPending) {
        const live = await this.sessions.findOne({ ...claim, status: 'in_progress', startedAt: {
          $lte: new Date(this.now().getTime() - INTERVIEW_WARNING_MS),
          $gt: new Date(this.now().getTime() - INTERVIEW_TIMEOUT_MS),
        } }).lean();
        if (live) await this.warning(String(live.userId), { sessionId, minutesRemaining: 5 });
        await this.sessions.updateOne(claim, { $set: { 'guard.warningPending': false } });
      }
      if (session.guard.evaluationPending && session.status === 'completed' && session.guard.reason === 'timeout') {
        await this.deps.evaluateCompleted(session);
        await this.sessions.updateOne(claim, { $set: { 'guard.evaluationPending': false } });
      }
    } finally {
      await this.sessions.updateOne(claim, { $set: { 'guard.deliveryToken': null, 'guard.deliveryLeaseUntil': new Date(0) } });
    }
  }

  async sweep(): Promise<void> {
    const now = this.now();
    const cursor = this.sessions.find({ $or: [
      { status: 'in_progress', startedAt: { $lte: new Date(now.getTime() - INTERVIEW_WARNING_MS) } },
      { status: 'in_progress', lastActivityAt: { $lt: new Date(now.getTime() - INTERVIEW_INACTIVE_MS) } },
      { 'guard.warningPending': true }, { 'guard.evaluationPending': true },
    ] }).select({ _id: 1 }).lean().cursor();
    let failed = 0;
    let firstError: unknown;
    for await (const session of cursor) {
      try {
        await this.reconcile(String(session._id));
        await this.deliver(String(session._id));
      } catch (error) { failed++; firstError ??= error; }
    }
    if (failed) throw new AggregateError([firstError], `Interview guard sweep failed for ${failed} sessions`);
  }
}
