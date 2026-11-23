// Integration tests for the InterviewSession model, service, score-port adapter and HTTP routes.
// They run against the in-memory replica set from the global vitest setup (transactions need it).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';

const mocks = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined), publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ add: mocks.add }) }));
vi.mock('../../../shared/sse/eventBus.js', () => ({ eventBus: { publishEnvelope: mocks.publish } }));
vi.mock('../../../shared/monitoring.js', () => ({ reportError: vi.fn() }));
// Real auth needs a database of users and tokens; the user id comes from a header instead.
vi.mock('../../../middleware/auth.js', () => ({
  authMiddleware: [(req: { user?: { id: string }; header(name: string): string | undefined }, _res: unknown, next: () => void) => {
    const id = req.header('x-test-user');
    if (id) req.user = { id };
    next();
  }],
}));
vi.mock('../../../middleware/rateLimitAdvanced.js', () => ({ rateLimiters: { ai: (_req: unknown, _res: unknown, next: () => void) => next() } }));

import { InterviewSession } from '../../../db/models/interviewSession.model.js';
import { InterviewEvaluationRequest } from '../../../db/models/interviewReport.model.js';
import { OutboxEvent } from '../../../db/models/outboxEvent.model.js';
import { errorHandler } from '../../../middleware/error.js';
import { toEnvelope } from '../../../shared/events/outboxRelay.js';
import { clearConsumerRegistry, getQueuesForEvent } from '../../../shared/events/consumerRegistry.js';
import { interviewRoutes } from '../../../modules/interview/interview.routes.js';
import {
  INTERVIEW_ABANDON_AFTER_MS,
  InterviewService,
  OpenSessionExistsError,
  type InterviewSessionView,
} from '../../../modules/interview/interview.service.js';
import { createMongoInterviewSessionPort } from '../../../modules/interview/interviewSession.port.js';
import { registerInterviewTurnAnsweredConsumer } from '../../../modules/interview/interviewTurnAnswered.consumer.js';
import { unwrapScoreJob } from '../../../modules/interview/workers/interviewScore.worker.js';
import type { InterviewSessionPort } from '../../../modules/interview/workers/interviewSessionPort.js';

const T0 = new Date('2026-11-20T10:00:00Z');
let now: Date;
let service: InterviewService;
let port: InterviewSessionPort;

const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 60 * 60_000;

beforeAll(async () => {
  await InterviewSession.init();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue(undefined);
  now = new Date(T0);
  service = new InterviewService({ now: () => now });
  port = createMongoInterviewSessionPort(InterviewSession, () => now);
});
afterEach(async () => {
  await InterviewSession.deleteMany({});
  await OutboxEvent.deleteMany({});
});

const answer = (session: InterviewSessionView, text = 'My answer') =>
  service.submitAnswer('u1', session.id, { turnIndex: session.currentTurnIndex, answer: text, stateVersion: session.stateVersion });

/** Score the turn the way the worker does, then return the refreshed view. */
async function score(session: InterviewSessionView) {
  const stored = await InterviewSession.findById(session.id).lean();
  const base = {
    sessionId: session.id, turnIndex: stored!.currentTurnIndex, expectedStateVersion: stored!.stateVersion,
    feedback: 'Reply', mode: 'ai' as const, model: 'test-model', promptVersion: 'v1',
  };
  const final = stored!.currentTurnIndex >= stored!.totalTurns - 1;
  const result = final
    ? await port.commitFinalResult({
      ...base,
      scorecard: { scores: { problemBreakdown: 80, technicalTradeoffs: 70, edgeCases: 60, communication: 90 }, strengths: ['a'], improvements: ['b'] },
    })
    : await port.commitTurnResult(base);
  return { result, view: await service.getSession('u1', session.id) };
}

describe('createSession', () => {
  it('starts in QUESTION_PENDING at version 1 and exposes only the current question', async () => {
    const session = await service.createSession('u1', 'backend');
    expect(session).toMatchObject({ role: 'backend', status: 'in_progress', state: 'QUESTION_PENDING', stateVersion: 1, currentTurnIndex: 0, totalTurns: 5 });
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ answer: null, feedback: null, hints: [] });
    expect(JSON.stringify(session)).not.toMatch(/checklist|questionId|topicKeys/);

    const stored = await InterviewSession.findById(session.id).lean();
    expect(stored!.turns).toHaveLength(5);
    expect(stored!.isOpen).toBe(true);
    expect(stored!.turnsCount).toBe(0);
    expect(stored!.retainUntil.getTime()).toBeGreaterThan(Date.now() + 364 * 24 * HOUR);
  });

  it('refuses a second open session with 409 and returns the open one', async () => {
    const first = await service.createSession('u1', 'backend');
    const error = await service.createSession('u1', 'fullstack').catch((e) => e);
    expect(error).toBeInstanceOf(OpenSessionExistsError);
    expect(error).toMatchObject({ statusCode: 409, code: 'interview_session_open' });
    expect(error.session.id).toBe(first.id);
    expect(await InterviewSession.countDocuments({ userId: 'u1' })).toBe(1);
  });

  it('lets only one of several simultaneous starts through', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => service.createSession('u1', 'backend')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(OpenSessionExistsError);
    expect(await InterviewSession.countDocuments({ userId: 'u1', isOpen: true })).toBe(1);
  });

  it('allows different users to run interviews at the same time', async () => {
    await service.createSession('u1', 'backend');
    await expect(service.createSession('u2', 'backend')).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('builds the partial unique index and the retention TTL index', async () => {
    const indexes = await InterviewSession.collection.indexes();
    expect(indexes.find((i) => i.name === 'uq_interviewsessions_open_per_user')).toMatchObject({
      unique: true, key: { userId: 1, isOpen: 1 }, partialFilterExpression: { isOpen: true },
    });
    expect(indexes.find((i) => i.name === 'ttl_interviewsessions_retain')).toMatchObject({ expireAfterSeconds: 0, key: { retainUntil: 1 } });
  });
});

describe('getCurrentSession', () => {
  it('returns null without a session and the open session after a reconnect', async () => {
    expect(await service.getCurrentSession('u1')).toBeNull();
    const created = await service.createSession('u1', 'backend');
    const resumed = await new InterviewService({ now: () => now }).getCurrentSession('u1');
    expect(resumed).toEqual(created);
  });

  it('shows the answered turn and the scoring state to a client that reconnects mid-score', async () => {
    const created = await service.createSession('u1', 'backend');
    await answer(created, 'first answer');
    const current = await service.getCurrentSession('u1');
    expect(current).toMatchObject({ state: 'SCORING', stateVersion: 2 });
    expect(current!.turns[0]!.answer).toBe('first answer');
  });
});

describe('submitAnswer and optimistic locking', () => {
  it('moves to SCORING, bumps the version and writes the outbox event in the same commit', async () => {
    const created = await service.createSession('u1', 'backend');
    const accepted = await answer(created, 'Use a queue');
    expect(accepted).toMatchObject({ state: 'SCORING', stateVersion: 2, currentTurnIndex: 0 });
    expect(accepted.turns[0]!.answer).toBe('Use a queue');

    const stored = await InterviewSession.findById(created.id).lean();
    expect(stored).toMatchObject({ state: 'SCORING', stateVersion: 2, turnsCount: 1 });
    const events = await OutboxEvent.find({ type: 'interview.turn.answered' }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: 'u1', aggregateType: 'interview_session', aggregateId: created.id, status: 'pending',
      payload: { sessionId: created.id, turnIndex: 0, stateVersion: 2 },
    });
  });

  it('rejects an outdated stateVersion with 409 and changes nothing', async () => {
    const created = await service.createSession('u1', 'backend');
    await answer(created);
    const error = await service.submitAnswer('u1', created.id, { turnIndex: 0, answer: 'again', stateVersion: created.stateVersion }).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 409, code: 'state_version_conflict' });
    expect(error.message).toMatch(/stateVersion is 2, the request used 1/);
    expect(await OutboxEvent.countDocuments({})).toBe(1);
    expect((await InterviewSession.findById(created.id).lean())!.turns[0]!.answer).toBe('My answer');
  });

  it('accepts exactly one of several simultaneous submits (double click)', async () => {
    const created = await service.createSession('u1', 'backend');
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => answer(created, `try ${i}`)));
    const won = results.filter((r) => r.status === 'fulfilled');
    expect(won).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ statusCode: 409 });
    }
    const stored = await InterviewSession.findById(created.id).lean();
    expect(stored).toMatchObject({ stateVersion: 2, turnsCount: 1, state: 'SCORING' });
    expect(await OutboxEvent.countDocuments({})).toBe(1);
  });

  it('lets only one of an answer and a hint sent at the same version win', async () => {
    const created = await service.createSession('u1', 'backend');
    const [a, h] = await Promise.allSettled([
      answer(created),
      service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: created.stateVersion }),
    ]);
    expect([a.status, h.status].sort()).toEqual(['fulfilled', 'rejected']);
    const stored = await InterviewSession.findById(created.id).lean();
    expect(stored!.stateVersion).toBe(2);
    // Whichever lost left no trace.
    expect((stored!.turns[0]!.answer !== null) !== (stored!.turns[0]!.hints.length === 1)).toBe(true);
  });

  it('rejects an answer while the previous one is still being scored with a descriptive illegal transition', async () => {
    const created = await service.createSession('u1', 'backend');
    const scoring = await answer(created);
    const error = await service.submitAnswer('u1', created.id, { turnIndex: 0, answer: 'x', stateVersion: scoring.stateVersion }).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 409, code: 'illegal_state_transition' });
    expect(error.message).toMatch(/SUBMIT_ANSWER.*SCORING/);
  });

  it('rejects an answer for a question that is not the current one', async () => {
    const created = await service.createSession('u1', 'backend');
    const error = await service.submitAnswer('u1', created.id, { turnIndex: 3, answer: 'x', stateVersion: created.stateVersion }).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 409, code: 'turn_mismatch' });
  });

  it('hides sessions of other users and malformed ids behind 404', async () => {
    const created = await service.createSession('u1', 'backend');
    await expect(service.submitAnswer('u2', created.id, { turnIndex: 0, answer: 'x', stateVersion: 1 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getSession('u2', created.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.getSession('u1', 'not-an-id')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rolls back the answer when the outbox write fails', async () => {
    const created = await service.createSession('u1', 'backend');
    const spy = vi.spyOn(OutboxEvent, 'create').mockRejectedValueOnce(new Error('outbox down'));
    await expect(answer(created)).rejects.toThrow('outbox down');
    spy.mockRestore();
    const stored = await InterviewSession.findById(created.id).lean();
    expect(stored).toMatchObject({ state: 'QUESTION_PENDING', stateVersion: 1, turnsCount: 0 });
    expect(stored!.turns[0]!.answer).toBeNull();
    // The same request can be retried.
    await expect(answer(created)).resolves.toMatchObject({ state: 'SCORING' });
  });

  it('turns the outbox event into the interview-score job data the worker expects', async () => {
    clearConsumerRegistry();
    registerInterviewTurnAnsweredConsumer();
    expect(getQueuesForEvent('interview.turn.answered')).toEqual(['interview-score']);

    const created = await service.createSession('u1', 'backend');
    await answer(created);
    const row = (await OutboxEvent.findOne({ type: 'interview.turn.answered' }))!;
    expect(unwrapScoreJob(toEnvelope(row))).toEqual({ sessionId: created.id, turnIndex: 0, stateVersion: 2 });
    expect(unwrapScoreJob({ sessionId: created.id, turnIndex: 1, stateVersion: 4 })).toEqual({ sessionId: created.id, turnIndex: 1, stateVersion: 4 });
    clearConsumerRegistry();
  });
});

describe('requestHint', () => {
  it('reveals hints one at a time and bumps the version each time', async () => {
    const created = await service.createSession('u1', 'backend');
    const stored = await InterviewSession.findById(created.id).lean();
    const hints = stored!.turns[0]!.question.hints;

    const first = await service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: 1 });
    expect(first).toMatchObject({ state: 'QUESTION_PENDING', stateVersion: 2 });
    expect(first.turns[0]!.hints).toEqual([hints[0]]);
    expect(first.turns[0]!.hintsRemaining).toBe(hints.length - 1);

    const second = await service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: 2 });
    expect(second.turns[0]!.hints).toEqual([hints[0], hints[1]]);
    expect(second.stateVersion).toBe(3);
  });

  it('rejects a hint with an outdated version', async () => {
    const created = await service.createSession('u1', 'backend');
    await service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: 1 });
    await expect(service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: 1 })).rejects.toMatchObject({ statusCode: 409, code: 'state_version_conflict' });
  });

  it('serialises simultaneous hint requests: one hint, one winner', async () => {
    const created = await service.createSession('u1', 'backend');
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: 1 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await InterviewSession.findById(created.id).lean())!.turns[0]!.hints).toHaveLength(1);
  });

  it('stops when every hint was used', async () => {
    const created = await service.createSession('u1', 'backend');
    const total = (await InterviewSession.findById(created.id).lean())!.turns[0]!.question.hints.length;
    let version = created.stateVersion;
    for (let i = 0; i < total; i++) version = (await service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: version })).stateVersion;
    await expect(service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: version })).rejects.toMatchObject({ statusCode: 409, code: 'no_hints_remaining' });
  });

  it('is not possible while the answer is being scored', async () => {
    const created = await service.createSession('u1', 'backend');
    const scoring = await answer(created);
    await expect(service.requestHint('u1', created.id, { turnIndex: 0, stateVersion: scoring.stateVersion })).rejects.toMatchObject({ code: 'illegal_state_transition' });
  });
});

describe('scoring port (the interview-score worker side)', () => {
  it('applies a result once and drops a stale or replayed one', async () => {
    const created = await service.createSession('u1', 'backend');
    await answer(created);
    const job = { sessionId: created.id, turnIndex: 0, expectedStateVersion: 2, feedback: 'Good', mode: 'ai' as const, model: 'm', promptVersion: 'p' };
    expect(await port.commitTurnResult(job)).toBe('applied');
    expect(await port.commitTurnResult(job)).toBe('stale');
    expect(await port.commitTurnResult({ ...job, expectedStateVersion: 1 })).toBe('stale');

    const stored = await InterviewSession.findById(created.id).lean();
    expect(stored).toMatchObject({ state: 'QUESTION_PENDING', stateVersion: 3, currentTurnIndex: 1 });
    expect(stored!.turns[0]!.feedback).toBe('Good');
  });

  it('refuses a result when the version moved on after the job was queued', async () => {
    const created = await service.createSession('u1', 'backend');
    await answer(created);
    await InterviewSession.updateOne({ _id: created.id }, { $inc: { stateVersion: 1 } });
    expect(await port.commitTurnResult({ sessionId: created.id, turnIndex: 0, expectedStateVersion: 2, feedback: 'x', mode: 'ai', model: 'm', promptVersion: 'p' })).toBe('stale');
  });

  it('runs a whole interview: five answers, five scores, completion, evaluation staged, slot released', async () => {
    let view = await service.createSession('u1', 'backend');
    const versions = [view.stateVersion];
    for (let turn = 0; turn < 5; turn++) {
      expect(view.currentTurnIndex).toBe(turn);
      expect(view.state).toBe('QUESTION_PENDING');
      view = await answer(view, `answer ${turn}`);
      versions.push(view.stateVersion);
      const scored = await score(view);
      expect(scored.result).toBe('applied');
      view = scored.view;
      versions.push(view.stateVersion);
    }
    // Strictly +1 per mutation: 1, 2, 3, ... 11.
    expect(versions).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(view).toMatchObject({ status: 'completed', state: 'COMPLETED', currentTurnIndex: 4 });
    expect(view.turns).toHaveLength(5);
    expect(view.scorecard?.scores.communication).toBe(90);

    const stored = await InterviewSession.findById(view.id).lean();
    expect(stored).toMatchObject({ isOpen: false, status: 'completed' });
    expect(stored!.closedAt).toEqual(now);
    expect(await InterviewEvaluationRequest.countDocuments({ sessionId: view.id })).toBe(1);

    // The one-open-session slot is free again.
    expect(await service.getCurrentSession('u1')).toBeNull();
    await expect(service.createSession('u1', 'fullstack')).resolves.toMatchObject({ role: 'fullstack' });
  });

  it('does not accept a sixth answer on a completed session', async () => {
    let view = await service.createSession('u1', 'backend');
    for (let turn = 0; turn < 5; turn++) {
      view = await answer(view);
      view = (await score(view)).view;
    }
    await expect(service.submitAnswer('u1', view.id, { turnIndex: 4, answer: 'extra', stateVersion: view.stateVersion }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('finishSession', () => {
  it('abandons an open interview and frees the slot', async () => {
    const created = await service.createSession('u1', 'backend');
    const finished = await service.finishSession('u1', created.id, { stateVersion: created.stateVersion });
    expect(finished).toMatchObject({ status: 'abandoned', state: 'COMPLETED', stateVersion: 2 });
    expect((await InterviewSession.findById(created.id).lean())!.isOpen).toBe(false);
    await expect(service.createSession('u1', 'backend')).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('is idempotent once closed', async () => {
    const created = await service.createSession('u1', 'backend');
    await service.finishSession('u1', created.id, { stateVersion: 1 });
    await expect(service.finishSession('u1', created.id, { stateVersion: 1 })).resolves.toMatchObject({ status: 'abandoned', stateVersion: 2 });
  });

  it('rejects an outdated version and refuses to abandon while an answer is being scored', async () => {
    const created = await service.createSession('u1', 'backend');
    const scoring = await answer(created);
    await expect(service.finishSession('u1', created.id, { stateVersion: 1 })).rejects.toMatchObject({ code: 'state_version_conflict' });
    await expect(service.finishSession('u1', created.id, { stateVersion: scoring.stateVersion })).rejects.toMatchObject({ code: 'illegal_state_transition' });
    expect((await InterviewSession.findById(created.id).lean())!.status).toBe('in_progress');
  });

  it('drops an in-flight score when the interview is abandoned first', async () => {
    const created = await service.createSession('u1', 'backend');
    await service.finishSession('u1', created.id, { stateVersion: 1 });
    expect(await port.commitTurnResult({ sessionId: created.id, turnIndex: 0, expectedStateVersion: 1, feedback: 'x', mode: 'ai', model: 'm', promptVersion: 'p' })).toBe('stale');
  });
});

describe('abandonment sweep (24 hours of inactivity)', () => {
  it('closes only sessions idle for more than 24 hours', async () => {
    const stale = await service.createSession('u1', 'backend');
    now = at(HOUR * 10);
    const fresh = await service.createSession('u2', 'backend');

    now = at(INTERVIEW_ABANDON_AFTER_MS + HOUR);
    expect(await service.abandonStaleSessions()).toBe(1);
    expect(await InterviewSession.findById(stale.id).lean()).toMatchObject({ status: 'abandoned', state: 'COMPLETED', isOpen: false, stateVersion: 2 });
    expect(await InterviewSession.findById(fresh.id).lean()).toMatchObject({ status: 'in_progress', isOpen: true });
  });

  it('is the full maintenance pass: abandons 24h-idle sessions and leaves a 3h-idle one to the guard', async () => {
    const stale = await service.createSession('u1', 'backend');
    now = at(HOUR * 21);
    const idle3h = await service.createSession('u2', 'backend');
    now = at(HOUR * 25);
    await service.sweep();
    expect((await InterviewSession.findById(stale.id).lean())!.status).toBe('abandoned');
    // Idle for 4h at this point: the guard's two hour rule expires it, it is not abandoned.
    expect((await InterviewSession.findById(idle3h.id).lean())!.status).toBe('expired');
  });

  it('applies when the user comes back: a stale session no longer blocks a new one', async () => {
    const stale = await service.createSession('u1', 'backend');
    now = at(INTERVIEW_ABANDON_AFTER_MS + 1_000);
    expect(await service.getCurrentSession('u1')).toBeNull();
    expect((await InterviewSession.findById(stale.id).lean())!.status).toBe('abandoned');
    await expect(service.createSession('u1', 'backend')).resolves.toMatchObject({ status: 'in_progress' });
  });

  it('keeps the slot free when the guard expires an inactive session (isOpen follows status)', async () => {
    const created = await service.createSession('u1', 'backend');
    now = at(3 * HOUR);
    expect(await service.getCurrentSession('u1')).toBeNull();
    expect(await InterviewSession.findById(created.id).lean()).toMatchObject({ status: 'expired', isOpen: false });
    await expect(service.createSession('u1', 'backend')).resolves.toMatchObject({ status: 'in_progress' });
  });
});

describe('45 minute timeout through the lifecycle guard', () => {
  it('completes a partly answered interview, frees the slot and hands the transcript to evaluation', async () => {
    let view = await service.createSession('u1', 'backend');
    view = await answer(view, 'only answer');
    view = (await score(view)).view;

    now = at(46 * 60_000);
    await service.sweep();
    const stored = await InterviewSession.findById(view.id).lean();
    expect(stored).toMatchObject({ status: 'completed', state: 'COMPLETED', isOpen: false });
    expect(stored!.stateVersion).toBe(view.stateVersion + 1);
    expect(await InterviewEvaluationRequest.countDocuments({ sessionId: view.id })).toBe(1);
    expect(mocks.add).toHaveBeenCalledWith('interview.evaluate', { sessionId: view.id }, expect.anything());
    // A late scoring result for the abandoned turn is dropped by the version fence.
    expect(await port.commitTurnResult({ sessionId: view.id, turnIndex: 1, expectedStateVersion: view.stateVersion, feedback: 'late', mode: 'ai', model: 'm', promptVersion: 'p' })).toBe('stale');
    await expect(service.createSession('u1', 'backend')).resolves.toMatchObject({ status: 'in_progress' });
  });
});

describe('HTTP API', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/interviews', interviewRoutes);
    app.use(errorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/interviews`;
    return () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const call = async (method: string, path: string, user: string | null, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  it('requires a user', async () => {
    expect((await call('GET', '/current', null)).status).toBe(401);
  });

  it('GET /current is null, then the open session', async () => {
    expect(await call('GET', '/current', 'h1')).toMatchObject({ status: 200, body: { success: true, data: null } });
    const started = await call('POST', '/', 'h1', { role: 'distributed_systems' });
    expect(started).toMatchObject({ status: 201, body: { data: { role: 'distributed_systems', stateVersion: 1 } } });
    const current = await call('GET', '/current', 'h1');
    expect(current.body.data.id).toBe(started.body.data.id);
    expect((await call('GET', `/${started.body.data.id}`, 'h1')).status).toBe(200);
    expect((await call('GET', `/${started.body.data.id}`, 'h2')).status).toBe(404);
  });

  it('validates the start body', async () => {
    expect((await call('POST', '/', 'h1', { role: 'janitor' })).status).toBe(400);
    expect((await call('POST', '/', 'h1', {})).status).toBe(400);
  });

  it('answers 409 with the open session when a second interview is started', async () => {
    const first = await call('POST', '/', 'h1', { role: 'backend' });
    const second = await call('POST', '/', 'h1', { role: 'backend' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ success: false, code: 'INTERVIEW_SESSION_OPEN' });
    expect(second.body.data.session.id).toBe(first.body.data.id);
  });

  it('accepts an answer once (202) and answers an outdated stateVersion with 409', async () => {
    const started = await call('POST', '/', 'h1', { role: 'backend' });
    const id = started.body.data.id;
    const path = `/${id}/turns/0/answer`;
    const ok = await call('POST', path, 'h1', { answer: 'Shard by user id', stateVersion: 1 });
    expect(ok).toMatchObject({ status: 202, body: { data: { state: 'SCORING', stateVersion: 2 } } });
    const stale = await call('POST', path, 'h1', { answer: 'Shard by user id', stateVersion: 1 });
    expect(stale).toMatchObject({ status: 409, body: { success: false, code: 'STATE_VERSION_CONFLICT' } });
  });

  it('validates the answer body', async () => {
    const { body } = await call('POST', '/', 'h1', { role: 'backend' });
    const path = `/${body.data.id}/turns/0/answer`;
    expect((await call('POST', path, 'h1', { answer: '   ', stateVersion: 1 })).status).toBe(400);
    expect((await call('POST', path, 'h1', { answer: 'ok' })).status).toBe(400);
    expect((await call('POST', path, 'h1', { answer: 'ok', stateVersion: -1 })).status).toBe(400);
    expect((await call('POST', `/${body.data.id}/turns/9/answer`, 'h1', { answer: 'ok', stateVersion: 1 })).status).toBe(400);
  });

  it('serves hints and finish', async () => {
    const { body } = await call('POST', '/', 'h1', { role: 'backend' });
    const id = body.data.id;
    const hint = await call('POST', `/${id}/turns/0/hint`, 'h1', { stateVersion: 1 });
    expect(hint).toMatchObject({ status: 200, body: { data: { stateVersion: 2 } } });
    expect(hint.body.data.turns[0].hints).toHaveLength(1);
    const finished = await call('POST', `/${id}/finish`, 'h1', { stateVersion: 2 });
    expect(finished).toMatchObject({ status: 200, body: { data: { status: 'abandoned' } } });
    expect((await call('GET', '/current', 'h1')).body.data).toBeNull();
  });
});

describe('model', () => {
  it('refuses more than five turns and out of range turn indexes', async () => {
    const turn = { question: { prompt: 'q', hints: [], checklist: [] }, answer: null, hints: [] };
    const invalid = new InterviewSession({ userId: 'u9', role: 'backend', turns: Array.from({ length: 6 }, () => turn) });
    await expect(invalid.validate()).rejects.toThrow(/at most 5 turns/);
    const badIndex = new InterviewSession({ userId: 'u9', role: 'backend', currentTurnIndex: 5 });
    await expect(badIndex.validate()).rejects.toThrow(/currentTurnIndex/);
    expect(mongoose.models.InterviewSession).toBe(InterviewSession);
  });

  it('clears isOpen for any update that closes the session', async () => {
    const created = await service.createSession('u1', 'backend');
    await InterviewSession.updateOne({ _id: created.id }, { $set: { status: 'expired' } });
    expect(await InterviewSession.findById(created.id).lean()).toMatchObject({ isOpen: false });
  });
});
