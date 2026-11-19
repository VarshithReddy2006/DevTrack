import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import express from 'express';
import { createServer, type Server } from 'node:http';
vi.mock('../../../shared/sse/eventBus.js', () => ({ eventBus: { publishEnvelope: vi.fn() } }));
vi.mock('../../../shared/monitoring.js', () => ({ reportError: vi.fn() }));
import { addInterviewGuardFields, type GuardedInterviewSession } from '../../../modules/interview/interviewGuard.schema.js';
import { InterviewGuardService, type InterviewGuardDeps } from '../../../modules/interview/interviewGuard.service.js';
import { createGuardedInterviewTurnHandler } from '../../../modules/interview/interviewGuard.http.js';
import { errorHandler } from '../../../middleware/error.js';
import type { AuthenticatedRequest } from '../../../middleware/auth.js';
import { z } from 'zod';

const schema = new Schema<GuardedInterviewSession>({
  userId: { type: String, required: true }, status: { type: String, default: 'in_progress' },
  state: { type: String, default: 'QUESTION_PENDING' }, stateVersion: { type: Number, default: 0 },
});
addInterviewGuardFields(schema);
// This fixture is explicitly not the absent production InterviewSession model owned by #347.
const Sessions = mongoose.model<GuardedInterviewSession>('InterviewGuardFixture', schema);
const Answers = mongoose.model('InterviewGuardAnswerFixture', new Schema({ sessionId: Schema.Types.ObjectId, answer: String }));
const START = new Date('2026-11-19T10:00:00Z');
let now: Date;
let db: MongoMemoryReplSet;
let service: InterviewGuardService;
let warning: Mock<NonNullable<InterviewGuardDeps['warning']>>;
let evaluate: Mock<InterviewGuardDeps['evaluateCompleted']>;
beforeAll(async () => {
  if (process.env.MONGODB_URI) throw new Error('An owned temporary MongoDB is required');
  db = await MongoMemoryReplSet.create({
    binary: { version: '7.0.14' }, replSet: { count: 1 },
    instanceOpts: [{ args: ['--wiredTigerCacheSizeGB', '0.25', '--wiredTigerEngineConfigString', 'log=(file_max=1MB,prealloc=false)'] }],
  });
  await mongoose.connect(db.getUri());
  await Promise.all([Sessions.init(), Answers.init()]);
});
beforeEach(() => {
  now = new Date(START);
  warning = vi.fn<NonNullable<InterviewGuardDeps['warning']>>().mockResolvedValue(undefined);
  evaluate = vi.fn<InterviewGuardDeps['evaluateCompleted']>().mockResolvedValue(undefined);
  service = new InterviewGuardService(Sessions, { now: () => now, warning, evaluateCompleted: evaluate });
});
afterEach(async () => { await Sessions.deleteMany({}); await Answers.deleteMany({}); });
afterAll(async () => { await mongoose.disconnect(); await db?.stop(); });
const advance = (minutes: number) => { now = new Date(START.getTime() + minutes * 60000); };
const create = (fields: Partial<GuardedInterviewSession> = {}) => Sessions.create({
  userId: 'owner', startedAt: START, lastActivityAt: START, ...fields,
});
const request = (session: GuardedInterviewSession) => ({ sessionId: String(session._id), userId: String(session.userId), stateVersion: session.stateVersion });

describe('interview guard: atomic turn limits', () => {
  it('accepts exactly six turns and rejects the seventh with HTTP 400 turn_limit_reached', async () => {
    const session = await create();
    for (let count = 1; count <= 6; count++) {
      const fresh = (await Sessions.findById(session._id))!;
      await service.acceptTurn(request(fresh), async (accepted, transaction) => {
        expect(accepted.turnsCount).toBe(count);
        expect(accepted.state).toBe('SCORING');
        await Answers.create([{ sessionId: session._id, answer: `answer-${count}` }], { session: transaction });
      });
      await Sessions.updateOne({ _id: session._id }, { $set: { state: 'QUESTION_PENDING' }, $inc: { stateVersion: 1 } });
    }
    const fresh = (await Sessions.findById(session._id))!;
    const write = vi.fn();
    await expect(service.acceptTurn(request(fresh), write)).rejects.toMatchObject({ code: 'turn_limit_reached', statusCode: 400 });
    expect(write).not.toHaveBeenCalled();
    expect(fresh.turnsCount).toBe(6);
  });
  it('cannot exceed six turns under concurrent requests even if legacy maxTurns exceeds six', async () => {
    const session = await create({ turnsCount: 5 });
    await Sessions.collection.updateOne({ _id: session._id }, { $set: { maxTurns: 100 } });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.acceptTurn(request(session), async () => 'accepted')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await Sessions.findById(session._id))?.turnsCount).toBe(6);
  });
  it('rolls back the reservation, state change and answer when the owning write fails', async () => {
    const session = await create();
    await expect(service.acceptTurn(request(session), async (_, transaction) => {
      await Answers.create([{ sessionId: session._id, answer: 'should roll back' }], { session: transaction });
      throw new Error('answer rejected');
    })).rejects.toThrow('answer rejected');
    const fresh = (await Sessions.findById(session._id))!;
    expect(fresh.toObject()).toMatchObject({ turnsCount: 0, stateVersion: 0, state: 'QUESTION_PENDING' });
    expect(await Answers.countDocuments()).toBe(0);
  });
  it.each(['foreign', 'stale', 'scoring'])('rejects %s requests without spending a turn', async kind => {
    const session = await create(kind === 'scoring' ? { state: 'SCORING' } : {});
    const data = request(session);
    if (kind === 'foreign') data.userId = 'other-owner';
    if (kind === 'stale') data.stateVersion = 9;
    await expect(service.acceptTurn(data, vi.fn())).rejects.toMatchObject({ statusCode: kind === 'foreign' ? 404 : 409 });
    expect((await Sessions.findById(session._id))?.turnsCount).toBe(0);
  });
  it('respects a lower server-configured turn limit', async () => {
    const session = await create({ maxTurns: 3, turnsCount: 3 });
    await expect(service.acceptTurn(request(session), vi.fn())).rejects.toMatchObject({ code: 'turn_limit_reached' });
  });
  it('rejects fractional counters and invalid turn identifiers or versions', async () => {
    await expect(create({ turnsCount: 0.5 })).rejects.toThrow();
    await expect(service.acceptTurn({ sessionId: 'invalid', userId: 'owner', stateVersion: 0 }, vi.fn())).rejects.toThrow();
    const session = await create();
    await expect(service.acceptTurn({ ...request(session), stateVersion: -1 }, vi.fn())).rejects.toThrow();
  });
});

describe('interview guard: clock boundaries and durable dispatch', () => {
  it('emits one owner-scoped warning at minute 40, with five minutes remaining, without changing stateVersion', async () => {
    const session = await create();
    advance(39.999); await service.sweep();
    expect(warning).not.toHaveBeenCalled();
    advance(40); await service.sweep(); await service.sweep();
    expect(warning).toHaveBeenCalledExactlyOnceWith('owner', { sessionId: String(session._id), minutesRemaining: 5 });
    expect((await Sessions.findById(session._id))?.stateVersion).toBe(0);
  });
  it('completes at minute 45 and retries evaluation delivery without repeating the state transition', async () => {
    const session = await create({ state: 'SCORING' });
    advance(45);
    evaluate.mockRejectedValueOnce(new Error('queue down'));
    await expect(service.sweep()).rejects.toThrow('1 sessions');
    let fresh = (await Sessions.findById(session._id))!;
    expect(fresh.toObject()).toMatchObject({ status: 'completed', state: 'COMPLETED', stateVersion: 1, guard: { reason: 'timeout', evaluationPending: true } });
    const staleScore = await Sessions.updateOne({ _id: session._id, status: 'in_progress', stateVersion: 0 }, { $set: { state: 'COMPLETED' } });
    expect(staleScore.modifiedCount).toBe(0);
    await service.sweep(); await service.sweep();
    fresh = (await Sessions.findById(session._id))!;
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(fresh.guard.evaluationPending).toBe(false);
    expect(fresh.stateVersion).toBe(1);
    expect(warning).not.toHaveBeenCalled();
  });
  it('rejects a new turn exactly at the deadline and persists completion', async () => {
    const session = await create();
    advance(45);
    await expect(service.acceptTurn(request(session), vi.fn())).rejects.toMatchObject({ statusCode: 400 });
    expect((await Sessions.findById(session._id))?.status).toBe('completed');
    expect((await Sessions.findById(session._id))?.turnsCount).toBe(0);
  });
  it('also closes a session when time crosses the deadline between reconciliation and the transaction', async () => {
    const session = await create();
    const clock = vi.fn().mockReturnValueOnce(new Date(START.getTime() + 44 * 60000)).mockReturnValue(new Date(START.getTime() + 45 * 60000));
    const crossing = new InterviewGuardService(Sessions, { now: clock, warning, evaluateCompleted: evaluate });
    await expect(crossing.acceptTurn(request(session), vi.fn())).rejects.toMatchObject({ code: 'session_timeout' });
    expect((await Sessions.findById(session._id))?.status).toBe('completed');
  });
  it('expires abandoned sessions strictly beyond two hours and does not evaluate them', async () => {
    const session = await create();
    advance(120.001); await service.sweep();
    expect((await Sessions.findById(session._id))?.toObject()).toMatchObject({ status: 'expired', stateVersion: 1, guard: { reason: 'inactive', evaluationPending: false } });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('does not classify exactly two hours of inactivity as abandoned; the elapsed deadline still completes it', async () => {
    const session = await create();
    advance(120); await service.sweep();
    expect((await Sessions.findById(session._id))?.status).toBe('completed');
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('retries failed warnings and suppresses stale warnings once the deadline passes', async () => {
    const session = await create();
    advance(40); warning.mockRejectedValueOnce(new Error('bus down'));
    await expect(service.sweep()).rejects.toThrow();
    expect((await Sessions.findById(session._id))?.guard.warningPending).toBe(true);
    advance(45); await service.sweep();
    expect(warning).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it('recovers undelivered warnings after a crash lease expires', async () => {
    const session = await create();
    advance(40); await service.reconcile(String(session._id));
    await Sessions.updateOne({ _id: session._id }, { $set: { 'guard.deliveryLeaseUntil': new Date(now.getTime() + 60000), 'guard.deliveryToken': 'crashed' } });
    await service.deliver(String(session._id)); expect(warning).not.toHaveBeenCalled();
    advance(41); await service.deliver(String(session._id)); expect(warning).toHaveBeenCalledOnce();
  });
  it('serializes concurrent sweeps and keeps failed sessions from preventing other deliveries', async () => {
    await create();
    advance(40); await Promise.all([service.sweep(), service.sweep(), service.sweep()]);
    expect(warning).toHaveBeenCalledOnce();
    await create();
    advance(45); evaluate.mockRejectedValueOnce(new Error('first failed'));
    await expect(service.sweep()).rejects.toThrow('1 sessions');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it.each(['completed', 'expired', 'abandoned'] as const)('leaves %s sessions unchanged', async status => {
    const session = await create({ status });
    advance(180); await service.sweep();
    expect((await Sessions.findById(session._id))?.stateVersion).toBe(0);
    expect(evaluate).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
  });
  it('requires the real model extension and an explicit evaluation adapter', () => {
    expect(() => new InterviewGuardService(Sessions, {} as never)).toThrow('evaluation adapter');
    const bare = mongoose.model<GuardedInterviewSession>('BareGuardFixture', new Schema({ userId: String }));
    expect(() => new InterviewGuardService(bare, { evaluateCompleted: evaluate })).toThrow('session field');
  });
});

describe('guarded turn HTTP binding', () => {
  let server: Server;
  let origin: string;
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    // Only this isolated fixture supplies authentication. Production uses the existing authMiddleware.
    app.use((req: AuthenticatedRequest, _, next) => {
      if (req.headers.authorization === 'fixture-owner') req.user = { id: 'owner' } as never;
      next();
    });
    app.post('/:sessionId/turns', (req, res, next) => createGuardedInterviewTurnHandler(service,
      body => z.object({ answer: z.string().min(1) }).parse(body).answer,
      async (session, answer, transaction) => {
        await Answers.create([{ sessionId: session._id, answer }], { session: transaction });
        return { stateVersion: session.stateVersion };
      })(req, res, next));
    app.use(errorHandler);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it.each(['unauthenticated', 'limit', 'invalid', 'success'])('returns the expected %s response through Express', async kind => {
    const session = await create(kind === 'limit' ? { turnsCount: 6 } : {});
    const response = await fetch(`${origin}/${session._id}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: kind === 'unauthenticated' ? '' : 'fixture-owner' },
      body: JSON.stringify({ stateVersion: 0, answer: kind === 'invalid' ? '' : 'answer' }),
    });
    expect(response.status).toBe(kind === 'unauthenticated' ? 401 : kind === 'limit' || kind === 'invalid' ? 400 : 200);
    const body = await response.json() as { code?: string };
    if (kind === 'limit') expect(body.code).toBe('turn_limit_reached');
    expect((await Sessions.findById(session._id))?.turnsCount).toBe(kind === 'success' ? 1 : kind === 'limit' ? 6 : 0);
  });
});
