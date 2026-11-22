// src/modules/interview/workers/interviewScore.worker.ts
//
// Evaluates one submitted interview answer.
//
//  1. Load the session and drop the job if it is stale: the session was abandoned, expired or
//     completed, or its stateVersion / turn already moved on (nothing is generated or written).
//  2. Stream the interviewer's reply through the LLM gateway and publish every piece as an
//     `interview.turn.delta` SSE event (seq 0, 1, 2, ... for this job).
//  3. On the final turn, score the whole transcript with the rubric prompt and validate the
//     model's JSON with Zod.
//  4. Whenever the model is unavailable (no keys, quota spent, provider errors, unusable
//     rubric JSON) fall back to deterministic checklist scoring and mark the session
//     `basic_mode` (Guardrail G8). Once a session is basic_mode, later turns stay checklist
//     scored so one scorecard never mixes the two methods per turn.
//  5. Commit with compare-and-set on stateVersion. A result that lost the race is discarded
//     without writing, and `interview.session.completed` is only emitted for an applied
//     final result.
//
// Storage is behind InterviewSessionPort (see interviewSessionPort.ts). Starting the BullMQ
// consumer needs a port, so it is deliberately not in workerDefinitions yet: it gets
// registered, together with a `ai` worker role, by whoever lands the InterviewSession model.
import { Job, type Worker } from 'bullmq';
import { AIQuotaExceededError } from '../../ai/quota.service.js';
import { llmGateway, type LLMGateway } from '../../ai/provider/LLMGateway.js';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { JobRetryConfig, QueueNames, type InterviewScoreJobData } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { eventBus } from '../../../shared/sse/eventBus.js';
import { logger } from '../../../shared/logger.js';
import type { InterviewMode, InterviewScorecard } from '../interview.types.js';
import {
  RUBRIC_MAX_TOKENS,
  RUBRIC_PROMPT_VERSION,
  RUBRIC_TEMPERATURE,
  buildRubricPrompt,
  parseRubricResponse,
} from '../prompts/rubricScore.prompt.js';
import {
  TURN_REPLY_MAX_TOKENS,
  TURN_REPLY_PROMPT_VERSION,
  TURN_REPLY_TEMPERATURE,
  buildTurnReplyPrompt,
} from '../prompts/turnReply.prompt.js';
import { speculativePrefetchService } from '../speculativePrefetch.service.js';
import {
  CHECKLIST_SCORER_MODEL,
  CHECKLIST_SCORER_VERSION,
  buildChecklistFeedback,
  scoreChecklistSession,
  scoreChecklistTurn,
} from '../scoring/checklistScorer.js';
import type { CommitResult, InterviewSessionPort, ScoringSession } from './interviewSessionPort.js';
import { enqueueCompletedInterview } from './interviewEvaluate.worker.js';

/** Quota bucket in DEFAULT_AI_QUOTAS. */
export const INTERVIEW_AI_FEATURE = 'interview';
/** Rubric JSON that fails validation is asked for once more before falling back. */
const RUBRIC_ATTEMPTS = 2;

export type DiscardReason =
  | 'session_missing'
  | 'session_abandoned'
  | 'session_expired'
  | 'session_completed'
  | 'version_mismatch'
  | 'turn_mismatch'
  | 'not_scoring'
  | 'no_answer';

export type FallbackReason = 'session_basic_mode' | 'quota_exceeded' | 'ai_unavailable' | 'invalid_rubric';

export type InterviewScoreOutcome =
  | { outcome: 'applied'; final: boolean; mode: InterviewMode; fallbackReason?: FallbackReason; deltas: number }
  | { outcome: 'discarded'; reason: DiscardReason; stage: 'preflight' | 'commit'; deltas: number };

export interface InterviewEventSink {
  turnDelta(userId: string, payload: { sessionId: string; turnIndex: number; stateVersion: number; delta: string; seq: number }): void;
  sessionCompleted(userId: string, payload: { sessionId: string; mode: InterviewMode }): Promise<void>;
}

export interface InterviewScoreDeps {
  port: InterviewSessionPort;
  gateway: Pick<LLMGateway, 'streamCompletion'>;
  events: InterviewEventSink;
  /** Persist/queue the full completed transcript for the separate detailed rubric report. */
  evaluateCompleted?: (session: ScoringSession) => Promise<void>;
}

export const eventBusSink: InterviewEventSink = {
  turnDelta: (userId, payload) => eventBus.emitInterviewTurnDelta(userId, payload),
  sessionCompleted: (userId, payload) => eventBus.emitInterviewSessionCompleted(userId, payload),
};

export function defaultDeps(port: InterviewSessionPort): InterviewScoreDeps {
  return { port, gateway: llmGateway, events: eventBusSink, evaluateCompleted: enqueueCompletedInterview };
}

/**
 * Why a result computed for `job` must not be written to `session`, or null if it is current.
 * The same conditions are enforced again, atomically, by the port's compare-and-set.
 */
export function staleReason(session: ScoringSession, job: InterviewScoreJobData): DiscardReason | null {
  if (session.status === 'abandoned') return 'session_abandoned';
  if (session.status === 'expired') return 'session_expired';
  if (session.status !== 'in_progress') return 'session_completed';
  if (session.stateVersion !== job.stateVersion) return 'version_mismatch';
  if (session.currentTurnIndex !== job.turnIndex) return 'turn_mismatch';
  if (session.state !== 'SCORING') return 'not_scoring';
  return null;
}

type ModelAttempt<T> = ({ ok: true } & T) | { ok: false; reason: FallbackReason };

function failureReason(error: unknown): FallbackReason {
  return error instanceof AIQuotaExceededError ? 'quota_exceeded' : 'ai_unavailable';
}

/** Run one streamed completion; `onDelta` sees each piece as it arrives. */
async function runCompletion(
  deps: InterviewScoreDeps,
  session: ScoringSession,
  request: { prompt: string; systemPrompt: string; temperature: number; maxTokens: number },
  onDelta?: (delta: string) => void,
): Promise<ModelAttempt<{ content: string; model: string }>> {
  try {
    for await (const event of deps.gateway.streamCompletion({
      ...request,
      userId: session.userId,
      feature: INTERVIEW_AI_FEATURE,
      // Transcripts are per user, so a prompt cache hit would only ever replay a bad answer.
      bypassCache: true,
      // An empty heuristic result tells us "no model" without streaming filler text.
      heuristicFallback: () => '',
    })) {
      if (event.type === 'delta') {
        onDelta?.(event.delta);
      } else if (event.response.provider === 'heuristic' || !event.response.content.trim()) {
        return { ok: false, reason: 'ai_unavailable' };
      } else {
        return { ok: true, content: event.response.content, model: event.response.model };
      }
    }
    return { ok: false, reason: 'ai_unavailable' };
  } catch (error) {
    logger.warn('[interview-score] Model call failed, using checklist scoring', {
      event: 'interview_score_ai_failed',
      sessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: failureReason(error) };
  }
}

async function runRubric(
  deps: InterviewScoreDeps,
  session: ScoringSession,
  turnIndex: number,
  lastReply: string,
): Promise<ModelAttempt<{ scorecard: InterviewScorecard; model: string }>> {
  const turns = session.turns.slice(0, turnIndex + 1).map((turn, index) => ({
    question: turn.question,
    answer: turn.answer,
    feedback: index === turnIndex ? lastReply : turn.feedback,
  }));
  const built = buildRubricPrompt({ role: session.role, turns });

  for (let attempt = 1; attempt <= RUBRIC_ATTEMPTS; attempt++) {
    const completion = await runCompletion(deps, session, {
      prompt: built.prompt,
      systemPrompt: built.systemPrompt,
      temperature: RUBRIC_TEMPERATURE,
      maxTokens: RUBRIC_MAX_TOKENS,
    });
    if (!completion.ok) return completion;

    const parsed = parseRubricResponse(completion.content);
    if (parsed.ok) return { ok: true, scorecard: parsed.scorecard, model: completion.model };
    logger.warn('[interview-score] Rubric response rejected', {
      event: 'interview_rubric_invalid',
      sessionId: session.id,
      attempt,
      error: parsed.error,
    });
  }
  return { ok: false, reason: 'invalid_rubric' };
}

export async function processInterviewScoreJob(
  data: InterviewScoreJobData,
  deps: InterviewScoreDeps,
): Promise<InterviewScoreOutcome> {
  const { port, events } = deps;
  let deltas = 0;
  const discard = (reason: DiscardReason, stage: 'preflight' | 'commit'): InterviewScoreOutcome => {
    logger.info('[interview-score] Discarded result', {
      event: 'interview_score_discarded',
      sessionId: data.sessionId, turnIndex: data.turnIndex, stateVersion: data.stateVersion, reason, stage,
    });
    return { outcome: 'discarded', reason, stage, deltas };
  };

  const session = await port.load(data.sessionId);
  if (!session) return discard('session_missing', 'preflight');
  // A post-commit enqueue failure must remain recoverable on the original final job's retry.
  if (session.status === 'completed' && session.stateVersion === data.stateVersion + 1
    && session.currentTurnIndex === data.turnIndex && data.turnIndex >= session.totalTurns - 1) {
    await deps.evaluateCompleted?.(session);
  }
  const stale = staleReason(session, data);
  if (stale) return discard(stale, 'preflight');

  const turn = session.turns[data.turnIndex];
  const answer = turn?.answer?.trim();
  if (!turn || !answer) return discard('no_answer', 'preflight');

  const isFinal = data.turnIndex >= session.totalTurns - 1;
  const checklistTurn = scoreChecklistTurn({ checklist: turn.question.checklist, answer });
  const basicReply = () => buildChecklistFeedback(turn.question, checklistTurn, data.turnIndex);

  let fallbackReason: FallbackReason | undefined = session.mode === 'basic_mode' ? 'session_basic_mode' : undefined;
  let feedback = '';
  let model = CHECKLIST_SCORER_MODEL;
  let promptVersion = CHECKLIST_SCORER_VERSION;

  if (!fallbackReason) {
    // Check speculative prefetch cache for instant (< 100ms) branch delivery
    const prefetched = await speculativePrefetchService.matchOrFallback(session.id, data.turnIndex, answer);
    if (prefetched.matched && prefetched.branch) {
      feedback = prefetched.branch.feedback;
      model = 'speculative-prefetch-v1';
      promptVersion = 'speculative-branch-hit';
      events.turnDelta(session.userId, {
        sessionId: session.id, turnIndex: data.turnIndex, stateVersion: data.stateVersion, delta: feedback, seq: 0,
      });
      deltas++;
    } else {
      const reply = buildTurnReplyPrompt({
        role: session.role,
        turnIndex: data.turnIndex,
        totalTurns: session.totalTurns,
        question: turn.question,
        answer,
        history: session.turns
          .slice(0, data.turnIndex)
          .flatMap((earlier) => (earlier.answer ? [{ prompt: earlier.question.prompt, answer: earlier.answer }] : [])),
      });
      let seq = 0;
      const streamed = await runCompletion(
        deps,
        session,
        { prompt: reply.prompt, systemPrompt: reply.systemPrompt, temperature: TURN_REPLY_TEMPERATURE, maxTokens: TURN_REPLY_MAX_TOKENS },
        (delta) => {
          events.turnDelta(session.userId, {
            sessionId: session.id, turnIndex: data.turnIndex, stateVersion: data.stateVersion, delta, seq: seq++,
          });
          deltas++;
        },
      );
      if (streamed.ok) {
        feedback = streamed.content;
        model = streamed.model;
        promptVersion = TURN_REPLY_PROMPT_VERSION;
      } else {
        fallbackReason = streamed.reason;
      }
    }

    // Prefetch next turn branch candidates in background
    if (!isFinal && session.turns[data.turnIndex + 1]) {
      speculativePrefetchService.registerPrefetch(
        session.id,
        data.turnIndex + 1,
        session.turns[data.turnIndex + 1].question.prompt
      );
    }
  }

  let scorecard: InterviewScorecard | undefined;
  if (isFinal) {
    if (!fallbackReason) {
      const rubric = await runRubric(deps, session, data.turnIndex, feedback);
      if (rubric.ok) {
        scorecard = rubric.scorecard;
        model = rubric.model;
        promptVersion = RUBRIC_PROMPT_VERSION;
      } else {
        fallbackReason = rubric.reason;
      }
    }
    if (!scorecard) {
      scorecard = scoreChecklistSession(
        session.turns.slice(0, data.turnIndex + 1).map((entry) => ({ checklist: entry.question.checklist, answer: entry.answer })),
      );
      model = CHECKLIST_SCORER_MODEL;
      promptVersion = CHECKLIST_SCORER_VERSION;
    }
  }

  if (fallbackReason) {
    // Text from a failed reply attempt is never stored. A reply that did stream fine on the
    // final turn stays even if only the rubric step fell back.
    if (!feedback) feedback = basicReply();
    if (fallbackReason !== 'session_basic_mode') {
      logger.warn('[interview-score] Falling back to checklist scoring (basic mode)', {
        event: 'interview_score_basic_mode', sessionId: session.id, turnIndex: data.turnIndex, reason: fallbackReason,
      });
    }
  }

  const mode: InterviewMode = fallbackReason ? 'basic_mode' : 'ai';
  const base = {
    sessionId: session.id,
    turnIndex: data.turnIndex,
    expectedStateVersion: data.stateVersion,
    feedback,
    mode,
    model,
    promptVersion,
  };
  const committed: CommitResult = scorecard
    ? await port.commitFinalResult({ ...base, scorecard })
    : await port.commitTurnResult(base);
  if (committed === 'stale') return discard('version_mismatch', 'commit');

  if (isFinal) {
    try {
      await events.sessionCompleted(session.userId, { sessionId: session.id, mode });
    } catch (error) {
      // The result is stored; the studio also refetches the session on reconnect.
      logger.error('[interview-score] Could not publish interview.session.completed', error, {
        event: 'interview_completed_event_failed', sessionId: session.id,
      });
    }
    if (deps.evaluateCompleted) {
      const completed = await port.load(session.id);
      if (!completed || completed.status !== 'completed') throw new Error('Completed interview snapshot is missing');
      await deps.evaluateCompleted(completed);
    }
  }
  return { outcome: 'applied', final: isFinal, mode, fallbackReason, deltas };
}

// ─── BullMQ wiring ──────────────────────────────────────────────────────────

let _worker: Worker<InterviewScoreJobData> | null = null;

/** One job per accepted answer; the job id makes re-enqueueing the same answer a no-op. */
export async function enqueueInterviewScore(data: InterviewScoreJobData): Promise<void> {
  await getOrCreateQueue(QueueNames.INTERVIEW_SCORE).add('interview-score', data, {
    ...JobRetryConfig.standard,
    jobId: `${data.sessionId}-${data.turnIndex}-${data.stateVersion}`,
  });
}

export function startInterviewScoreWorker(port: InterviewSessionPort, deps: InterviewScoreDeps = defaultDeps(port)): Worker<InterviewScoreJobData> {
  if (_worker) return _worker;

  _worker = createDlqWorker<InterviewScoreJobData>(
    QueueNames.INTERVIEW_SCORE,
    async (job: Job<InterviewScoreJobData>) => {
      const result = await processInterviewScoreJob(job.data, deps);
      logger.debug('[interview-score] Processed answer', {
        event: 'interview_score_processed', jobId: job.id, sessionId: job.data.sessionId, outcome: result.outcome,
      });
      return result;
    },
    { connection: getRedisClient(), concurrency: 5, ...JobRetryConfig.standard },
  );

  _worker.on('failed', (job, err) => {
    logger.error('[interview-score] Job failed', err, { event: 'interview_score_failed', jobId: job?.id, sessionId: job?.data.sessionId });
  });
  _worker.on('error', (err) => {
    logger.error('[interview-score] Worker error', err, { event: 'interview_score_worker_error' });
  });
  logger.info('[interview-score] Worker started', { event: 'interview_score_worker_started', queue: QueueNames.INTERVIEW_SCORE });
  return _worker;
}

export async function stopInterviewScoreWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
