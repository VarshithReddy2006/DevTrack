import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIQuotaExceededError } from '../../../modules/ai/quota.service.js';
import { AIStreamInterruptedError } from '../../../modules/ai/provider/AIStreamInterruptedError.js';
import type { LLMCompletionRequest, LLMCompletionResponse, LLMStreamEvent } from '../../../modules/ai/provider/LLMGateway.js';
import {
  enqueueInterviewScore,
  processInterviewScoreJob,
  startInterviewScoreWorker,
  staleReason,
  stopInterviewScoreWorker,
  type InterviewEventSink,
  type InterviewScoreDeps,
} from '../../../modules/interview/workers/interviewScore.worker.js';
import type { InterviewScoreJobData } from '../../../shared/jobs/types.js';
import { MemorySessionPort, scoringSession, type StoredSession } from './helpers/memorySessionPort.js';

interface Script {
  deltas?: string[];
  done?: Partial<LLMCompletionResponse>;
  /** Runs after the deltas, before the stream finishes (used to change the session mid-flight). */
  midway?: () => void;
  fail?: unknown;
}

function fakeGateway(scripts: Script[]) {
  const calls: LLMCompletionRequest[] = [];
  return {
    calls,
    async *streamCompletion(request: LLMCompletionRequest): AsyncGenerator<LLMStreamEvent> {
      calls.push(request);
      const script = scripts.shift();
      if (!script) throw new Error('unexpected model call');
      for (const delta of script.deltas ?? []) yield { type: 'delta', delta };
      script.midway?.();
      if (script.fail) throw script.fail;
      const content = script.done?.content ?? (script.deltas ?? []).join('');
      yield {
        type: 'done',
        response: {
          content, model: 'test-model', provider: 'gemini', tokensUsed: 10, latencyMs: 1, cached: false,
          cacheHit: false, cost: 0, fallbackTriggered: false, promptHash: 'h', ...script.done,
        },
      };
    },
  };
}

/** What the gateway yields when no provider is usable and the empty heuristic fallback kicks in. */
const noAi: Script = { done: { content: '', provider: 'heuristic', model: 'heuristic-rule-engine' } };

const rubricJson = (scores: Partial<Record<string, unknown>> = {}) => JSON.stringify({
  scores: { problemBreakdown: 80, technicalTradeoffs: 70, edgeCases: 60, communication: 90, ...scores },
  strengths: ['Clear scoping'],
  improvements: ['Discuss failure modes'],
});

function setup(scripts: Script[] = []) {
  const port = new MemorySessionPort();
  const gateway = fakeGateway(scripts);
  const deltas: Parameters<InterviewEventSink['turnDelta']>[] = [];
  const completed: Parameters<InterviewEventSink['sessionCompleted']>[] = [];
  const deps: InterviewScoreDeps = {
    port,
    gateway,
    events: {
      turnDelta: (...args) => { deltas.push(args); },
      sessionCompleted: async (...args) => { completed.push(args); },
    },
  };
  const job = (session: StoredSession): InterviewScoreJobData => ({
    sessionId: session.id, turnIndex: session.currentTurnIndex, stateVersion: session.stateVersion,
  });
  return { port, gateway, deltas, completed, deps, job };
}

const ANSWER = 'I would clarify requirements first, estimate 40 writes per second, then use a base62 counter with a cache in front of a key value store.';

describe('completed transcript evaluation handoff', () => {
  it('hands the persisted completed transcript to the evaluator after the final CAS', async () => {
    const t = setup();
    const evaluateCompleted = vi.fn().mockResolvedValue(undefined);
    t.deps.evaluateCompleted = evaluateCompleted;
    const session = t.port.add(scoringSession({ answers: [ANSWER], totalTurns: 1, mode: 'basic_mode' }));
    await processInterviewScoreJob(t.job(session), t.deps);
    expect(evaluateCompleted).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed', stateVersion: 5, turns: expect.arrayContaining([expect.objectContaining({ answer: ANSWER })]),
    }));
    expect(t.port.writes).toHaveLength(1);
  });
  it('recovers a post-commit enqueue failure when the original final job retries', async () => {
    const t = setup();
    const evaluateCompleted = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined);
    t.deps.evaluateCompleted = evaluateCompleted;
    const session = t.port.add(scoringSession({ answers: [ANSWER], totalTurns: 1, mode: 'basic_mode' }));
    const data = t.job(session);
    await expect(processInterviewScoreJob(data, t.deps)).rejects.toThrow('queue unavailable');
    expect(session.status).toBe('completed');
    expect(t.completed).toHaveLength(1);
    expect(await processInterviewScoreJob(data, t.deps)).toMatchObject({ outcome: 'discarded', reason: 'session_completed' });
    expect(evaluateCompleted).toHaveBeenCalledTimes(2);
    expect(t.port.writes).toHaveLength(1);
  });
  it('does not hand off non-final results or unrelated completed versions', async () => {
    const t = setup();
    const evaluateCompleted = vi.fn();
    t.deps.evaluateCompleted = evaluateCompleted;
    const session = t.port.add(scoringSession({ answers: [ANSWER], mode: 'basic_mode' }));
    await processInterviewScoreJob(t.job(session), t.deps);
    session.status = 'completed';
    await processInterviewScoreJob({ ...t.job(session), stateVersion: 99 }, t.deps);
    expect(evaluateCompleted).not.toHaveBeenCalled();
  });
});

describe('interview-score worker: streaming', () => {
  it('publishes every delta with monotonic seq, the job turn and stateVersion, and stores the reply', async () => {
    const t = setup([{ deltas: ['Good ', 'scoping. ', 'Add ', 'failure modes.'] }]);
    const session = t.port.add(scoringSession({ answers: [ANSWER] }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(t.deltas).toEqual([
      ['user-1', { sessionId: 'session-1', turnIndex: 0, stateVersion: 4, delta: 'Good ', seq: 0 }],
      ['user-1', { sessionId: 'session-1', turnIndex: 0, stateVersion: 4, delta: 'scoping. ', seq: 1 }],
      ['user-1', { sessionId: 'session-1', turnIndex: 0, stateVersion: 4, delta: 'Add ', seq: 2 }],
      ['user-1', { sessionId: 'session-1', turnIndex: 0, stateVersion: 4, delta: 'failure modes.', seq: 3 }],
    ]);
    expect(outcome).toEqual({ outcome: 'applied', final: false, mode: 'ai', fallbackReason: undefined, deltas: 4 });
    expect(t.port.writes).toEqual([expect.objectContaining({
      sessionId: 'session-1', turnIndex: 0, expectedStateVersion: 4, feedback: 'Good scoping. Add failure modes.',
      mode: 'ai', model: 'test-model', promptVersion: 'turn-reply-v1',
    })]);
    expect(t.completed).toEqual([]);
    expect(t.port.sessions.get('session-1')).toMatchObject({ state: 'QUESTION_PENDING', stateVersion: 5, currentTurnIndex: 1 });
  });

  it('asks the gateway for the interview quota bucket, uncached, with the answer fenced as data', async () => {
    const t = setup([{ deltas: ['ok'] }]);
    const session = t.port.add(scoringSession({ answers: [ANSWER] }));

    await processInterviewScoreJob(t.job(session), t.deps);

    const request = t.gateway.calls[0]!;
    expect(request).toMatchObject({ userId: 'user-1', feature: 'interview', bypassCache: true });
    expect(request.prompt).toContain(`<candidate_answer>\n${ANSWER}\n</candidate_answer>`);
    expect(request.prompt).toContain(session.turns[0]!.question.prompt);
  });

  it('restarts seq at 0 for each turn and tags the turn and version of that job', async () => {
    const t = setup([{ deltas: ['a', 'b'] }, { deltas: ['c', 'd'] }]);
    const session = t.port.add(scoringSession({ answers: [ANSWER, ANSWER, ANSWER], currentTurnIndex: 0 }));

    await processInterviewScoreJob(t.job(session), t.deps);
    session.state = 'SCORING'; // the session service accepts the next answer
    await processInterviewScoreJob(t.job(session), t.deps);

    expect(t.deltas.map(([, p]) => [p.turnIndex, p.stateVersion, p.seq])).toEqual([[0, 4, 0], [0, 4, 1], [1, 5, 0], [1, 5, 1]]);
  });
});

describe('interview-score worker: stale results', () => {
  const cases: [string, (s: StoredSession) => void, string][] = [
    ['abandoned', s => { s.status = 'abandoned'; }, 'session_abandoned'],
    ['expired', s => { s.status = 'expired'; }, 'session_expired'],
    ['already completed', s => { s.status = 'completed'; s.state = 'COMPLETED'; }, 'session_completed'],
    ['advanced to a newer stateVersion', s => { s.stateVersion += 1; }, 'version_mismatch'],
    ['moved to another turn', s => { s.currentTurnIndex += 1; }, 'turn_mismatch'],
    ['no longer scoring', s => { s.state = 'QUESTION_PENDING'; }, 'not_scoring'],
  ];

  it.each(cases)('drops the job before calling the model when the session was %s', async (_name, change, reason) => {
    const t = setup([{ deltas: ['never used'] }]);
    const session = t.port.add(scoringSession({ answers: [ANSWER, ANSWER], currentTurnIndex: 0 }));
    const job = t.job(session);
    change(session);

    const outcome = await processInterviewScoreJob(job, t.deps);

    expect(outcome).toEqual({ outcome: 'discarded', reason, stage: 'preflight', deltas: 0 });
    expect(t.gateway.calls).toHaveLength(0);
    expect(t.deltas).toEqual([]);
    expect(t.port.writes).toEqual([]);
    expect(t.completed).toEqual([]);
  });

  it('drops a job for a session that no longer exists', async () => {
    const t = setup();
    expect(await processInterviewScoreJob({ sessionId: 'gone', turnIndex: 0, stateVersion: 1 }, t.deps))
      .toMatchObject({ outcome: 'discarded', reason: 'session_missing' });
  });

  it('drops a job whose turn has no answer', async () => {
    const t = setup();
    const session = t.port.add(scoringSession({ answers: [] , currentTurnIndex: 0 }));
    expect(await processInterviewScoreJob(t.job(session), t.deps)).toMatchObject({ outcome: 'discarded', reason: 'no_answer' });
    expect(t.gateway.calls).toHaveLength(0);
  });

  it('discards a late result without writing when the session is abandoned while the reply streams', async () => {
    let session!: StoredSession;
    const t = setup([{ deltas: ['late ', 'reply'], midway: () => { session.status = 'abandoned'; } }]);
    session = t.port.add(scoringSession({ answers: [ANSWER, ANSWER], currentTurnIndex: 0 }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(outcome).toMatchObject({ outcome: 'discarded', reason: 'version_mismatch', stage: 'commit' });
    expect(t.port.writes).toEqual([]);
    expect(session).toMatchObject({ status: 'abandoned', stateVersion: 4, currentTurnIndex: 0 });
    expect(session.turns[0]!.feedback).toBeNull();
    expect(t.completed).toEqual([]);
  });

  it('discards a late final result when the session advanced during scoring, and does not announce completion', async () => {
    let session!: StoredSession;
    const t = setup([
      { deltas: ['Wrap up.'] },
      { done: { content: rubricJson() }, midway: () => { session.stateVersion += 1; } },
    ]);
    session = t.port.add(scoringSession({ answers: [ANSWER, ANSWER, ANSWER, ANSWER, ANSWER] }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(outcome).toMatchObject({ outcome: 'discarded', stage: 'commit' });
    expect(t.port.writes).toEqual([]);
    expect(session.scorecard).toBeUndefined();
    expect(t.completed).toEqual([]);
  });

  it('applies a redelivered job at most once', async () => {
    const t = setup([{ deltas: ['once'] }, { deltas: ['twice'] }]);
    const session = t.port.add(scoringSession({ answers: [ANSWER, ANSWER], currentTurnIndex: 0 }));
    const job = t.job(session);

    const first = await processInterviewScoreJob(job, t.deps);
    const second = await processInterviewScoreJob(job, t.deps);

    expect(first.outcome).toBe('applied');
    expect(second).toMatchObject({ outcome: 'discarded', reason: 'version_mismatch' });
    expect(t.port.writes).toHaveLength(1);
    expect(t.gateway.calls).toHaveLength(1);
  });

  it('staleReason is null only for the exact in-progress SCORING version and turn', () => {
    const session = scoringSession({ answers: [ANSWER] });
    expect(staleReason(session, { sessionId: session.id, turnIndex: 0, stateVersion: 4 })).toBeNull();
    expect(staleReason(session, { sessionId: session.id, turnIndex: 0, stateVersion: 3 })).toBe('version_mismatch');
  });
});

describe('interview-score worker: final turn rubric', () => {
  const fiveAnswers = [ANSWER, ANSWER, ANSWER, ANSWER, ANSWER];

  it('streams the closing reply, scores the transcript, stores model and promptVersion and announces completion', async () => {
    const t = setup([
      { deltas: ['Great ', 'finish.'] },
      { done: { content: '```json\n' + rubricJson({ edgeCases: 140, communication: -3 }) + '\n```', model: 'rubric-model' } },
    ]);
    const session = t.port.add(scoringSession({ answers: fiveAnswers }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(outcome).toMatchObject({ outcome: 'applied', final: true, mode: 'ai' });
    expect(t.deltas.map(([, p]) => p.delta)).toEqual(['Great ', 'finish.']);
    expect(t.port.writes[0]).toMatchObject({
      feedback: 'Great finish.', mode: 'ai', model: 'rubric-model', promptVersion: 'rubric-v1',
      scorecard: {
        scores: { problemBreakdown: 80, technicalTradeoffs: 70, edgeCases: 100, communication: 0 },
        strengths: ['Clear scoping'], improvements: ['Discuss failure modes'],
      },
    });
    expect(session).toMatchObject({ status: 'completed', state: 'COMPLETED', stateVersion: 5 });
    expect(t.completed).toEqual([['user-1', { sessionId: 'session-1', mode: 'ai' }]]);
    // The rubric call is not streamed to the browser.
    expect(t.deltas).toHaveLength(2);
    expect(t.gateway.calls[1]!.prompt).toContain('<transcript>');
  });

  it('asks again once when the rubric JSON is unusable, then accepts a valid one', async () => {
    const t = setup([{ deltas: ['Done.'] }, { done: { content: 'not json at all' } }, { done: { content: rubricJson() } }]);
    const session = t.port.add(scoringSession({ answers: fiveAnswers }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(outcome).toMatchObject({ outcome: 'applied', mode: 'ai' });
    expect(t.gateway.calls).toHaveLength(3);
  });

  it('falls back to checklist scoring in basic mode when the rubric stays malformed, keeping the streamed reply', async () => {
    const t = setup([
      { deltas: ['Solid ', 'wrap up.'] },
      { done: { content: '{"scores":{"problemBreakdown":"high"}}' } },
      { done: { content: JSON.stringify({ scores: { problemBreakdown: 80, technicalTradeoffs: 70, communication: 90 }, strengths: [], improvements: [] }) } },
    ]);
    const session = t.port.add(scoringSession({ answers: fiveAnswers }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(outcome).toMatchObject({ outcome: 'applied', final: true, mode: 'basic_mode', fallbackReason: 'invalid_rubric' });
    expect(t.port.writes[0]).toMatchObject({ feedback: 'Solid wrap up.', mode: 'basic_mode', model: 'checklist-scorer', promptVersion: 'checklist-v1' });
    expect(session.scorecard?.scores.problemBreakdown).toBeGreaterThanOrEqual(0);
    expect(t.completed).toEqual([['user-1', { sessionId: 'session-1', mode: 'basic_mode' }]]);
  });

  it('uses the checklist scorecard when the quota runs out between the reply and the rubric', async () => {
    const t = setup([{ deltas: ['Fine.'] }, { fail: new AIQuotaExceededError('interview', 10, 11, new Date()) }]);
    const session = t.port.add(scoringSession({ answers: fiveAnswers }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(outcome).toMatchObject({ mode: 'basic_mode', fallbackReason: 'quota_exceeded' });
    expect(t.port.writes[0]!.feedback).toBe('Fine.');
  });
});

describe('interview-score worker: basic mode fallback (G8)', () => {
  it('scores a turn from the checklist when no AI provider is configured, without streaming or failing', async () => {
    const t = setup([noAi]);
    const session = t.port.add(scoringSession({ answers: [ANSWER, ANSWER], currentTurnIndex: 0 }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(outcome).toEqual({ outcome: 'applied', final: false, mode: 'basic_mode', fallbackReason: 'ai_unavailable', deltas: 0 });
    expect(t.deltas).toEqual([]);
    expect(t.port.writes[0]).toMatchObject({ mode: 'basic_mode', model: 'checklist-scorer', promptVersion: 'checklist-v1' });
    expect(t.port.writes[0]!.feedback).toMatch(/^Basic mode review: your answer covered \d of 6 expected points/);
    expect(t.port.sessions.get('session-1')).toMatchObject({ mode: 'basic_mode', state: 'QUESTION_PENDING' });
  });

  it.each([
    ['quota is exhausted', new AIQuotaExceededError('interview', 10, 11, new Date()), 'quota_exceeded'],
    ['the gateway throws', new Error('boom'), 'ai_unavailable'],
  ])('falls back when %s', async (_name, fail, reason) => {
    const t = setup([{ fail }]);
    const session = t.port.add(scoringSession({ answers: [ANSWER] }));
    const outcome = await processInterviewScoreJob(t.job(session), t.deps);
    expect(outcome).toMatchObject({ outcome: 'applied', mode: 'basic_mode', fallbackReason: reason });
  });

  it('replaces a half-streamed reply with the checklist note when the provider drops mid-stream', async () => {
    const t = setup([{ deltas: ['Half of a '], fail: new AIStreamInterruptedError('gemini', 'Half of a ', new Error('reset')) }]);
    const session = t.port.add(scoringSession({ answers: [ANSWER, ANSWER], currentTurnIndex: 0 }));

    const outcome = await processInterviewScoreJob(t.job(session), t.deps);

    expect(outcome).toMatchObject({ mode: 'basic_mode', deltas: 1 });
    expect(t.port.writes[0]!.feedback).toMatch(/^Basic mode review/);
  });

  it('completes a whole five-turn interview with no AI and labels the scorecard basic mode', async () => {
    const t = setup([noAi]);
    const answers = [ANSWER, 'Use a queue and retry failed jobs with idempotent handlers.', 'Cache hot keys and shard by user id.', 'Handle timeouts, retries and duplicate events.', 'Add metrics, tracing and alerts on error rate.'];
    const session = t.port.add(scoringSession({ answers, currentTurnIndex: 0 }));

    for (let turn = 0; turn < 5; turn++) {
      const current = t.port.sessions.get('session-1')!;
      const outcome = await processInterviewScoreJob(t.job(current), t.deps);
      expect(outcome).toMatchObject({ outcome: 'applied', mode: 'basic_mode', final: turn === 4 });
      if (turn < 4) current.state = 'SCORING';
    }

    expect(session).toMatchObject({ status: 'completed', mode: 'basic_mode' });
    expect(session.scorecard).toBeDefined();
    for (const value of Object.values(session.scorecard!.scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    // The model is only tried once; later turns stay in basic mode without another call.
    expect(t.gateway.calls).toHaveLength(1);
    expect(t.port.writes).toHaveLength(5);
    expect(t.completed).toEqual([['user-1', { sessionId: 'session-1', mode: 'basic_mode' }]]);
    expect(session.model).toBe('checklist-scorer');
  });
});

describe('interview-score worker: BullMQ wiring', () => {
  beforeEach(async () => { await stopInterviewScoreWorker(); });

  it('consumes jobs from the interview-score queue and runs them through the processor', async () => {
    const t = setup([{ deltas: ['queued reply'] }]);
    const session = t.port.add(scoringSession({ answers: [ANSWER, ANSWER], currentTurnIndex: 0 }));
    const worker = startInterviewScoreWorker(t.port, t.deps);
    expect(startInterviewScoreWorker(t.port, t.deps)).toBe(worker);
    expect((worker as unknown as { name: string }).name).toBe('interview-score');

    await enqueueInterviewScore(t.job(session));

    await vi.waitFor(() => expect(t.port.writes).toHaveLength(1));
    expect(t.deltas.map(([, p]) => p.delta)).toEqual(['queued reply']);
    await stopInterviewScoreWorker();
  });
});
