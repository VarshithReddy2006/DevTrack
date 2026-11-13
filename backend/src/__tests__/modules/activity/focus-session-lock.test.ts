import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { User, UserXp, FocusSession, UnifiedRuntimeState } from '../../../db/models/index.js';
import activityRoutes from '../../../modules/activity/activity.routes.js';
import { errorHandler } from '../../../middleware/error.js';
import {
  FocusEngine, FocusSessionConflictError, RUNNING_STALE_MS, PAUSED_STALE_MS,
} from '../../../modules/activity/focusEngine.service.js';

const fixture = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock('@clerk/backend', () => ({ verifyToken: fixture.verify }));
vi.mock('../../../services/auth/ClerkUserSyncService.js', () => ({ syncClerkUser: vi.fn() }));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitRuntimeStatePatch: vi.fn() } }));
vi.mock('../../../shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const userId = '000000000000000000000071';
let server: Server;
let base: string;

beforeAll(async () => {
  // The partial unique index is the lock under test, so it must exist.
  await Promise.all([User.init(), UserXp.init(), FocusSession.init()]);
  const app = express();
  app.use(express.json());
  app.use('/api/v1/activity', activityRoutes);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => resolve(listener));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/activity`;
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_focus_lock');
  fixture.verify.mockResolvedValue({ sub: 'clerk_focus_lock' });
  await User.create({ _id: userId, clerkId: 'clerk_focus_lock', username: 'focuslock', email: 'lock@example.test',
    displayName: 'Focus Lock', timezone: 'UTC' });
  await UserXp.create({ userId });
});

afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function post(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() as { message?: string; error?: { code?: string } } };
}

describe('one live focus session per user', () => {
  it('lets only one of several simultaneous HTTP starts through', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => post('/focus/start', { duration: 25, mode: 'deep_work' })),
    );
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    expect(results.filter(r => r.status === 409)).toHaveLength(5);
    expect(await FocusSession.countDocuments({ userId, status: { $in: ['running', 'paused'] } })).toBe(1);
  });

  it('lets only one of several simultaneous engine starts through', async () => {
    const engine = new FocusEngine();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => engine.startSession(userId, 'deep_work', 25)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter(r => r.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(FocusSessionConflictError);
    }
    expect(await FocusSession.countDocuments({ userId })).toBe(1);
  });

  it('rejects a start while a session is paused, and allows one after stop', async () => {
    expect((await post('/focus/start', { duration: 25, mode: 'deep_work' })).status).toBe(200);
    expect((await post('/focus/pause')).status).toBe(200);
    expect((await post('/focus/start', { duration: 25, mode: 'deep_work' })).status).toBe(409);
    expect((await post('/focus/stop')).status).toBe(200);
    expect((await post('/focus/start', { duration: 25, mode: 'deep_work' })).status).toBe(200);
    expect(await FocusSession.countDocuments({ userId, status: 'running' })).toBe(1);
  });

  it('does not let one user block another', async () => {
    const engine = new FocusEngine();
    await engine.startSession(userId, 'deep_work', 25);
    await expect(engine.startSession(new Types.ObjectId().toString(), 'deep_work', 25)).resolves.toBeDefined();
  });
});

describe('tenant isolation', () => {
  it('denies pause, resume, heartbeat, complete and abort to a different user', async () => {
    const engine = new FocusEngine();
    const owner = new Types.ObjectId().toString();
    const intruder = new Types.ObjectId().toString();
    const { sessionId } = await engine.startSession(owner, 'deep_work', 25);

    expect(await engine.pauseSession(sessionId, intruder)).toBeNull();
    await engine.recordHeartbeat(sessionId, intruder);
    await engine.abortSession(sessionId, intruder);
    expect(await engine.completeSession(sessionId, intruder)).toBeNull();
    let doc = await FocusSession.findById(sessionId);
    expect(doc).toMatchObject({ status: 'running', heartbeatCount: 0 });

    expect(await engine.pauseSession(sessionId, owner)).not.toBeNull();
    expect(await engine.resumeSession(sessionId, intruder)).toBeNull();
    expect((await FocusSession.findById(sessionId))!.status).toBe('paused');

    expect(await engine.resumeSession(sessionId, owner)).not.toBeNull();
    await engine.recordHeartbeat(sessionId, owner);
    doc = await FocusSession.findById(sessionId);
    expect(doc).toMatchObject({ status: 'running', heartbeatCount: 1 });
    expect(await engine.completeSession(sessionId, owner)).not.toBeNull();
  });
});

describe('zombie session reaper', () => {
  const engine = new FocusEngine();
  const minutes = (n: number) => n * 60_000;

  async function seed(over: Record<string, unknown>) {
    const startedAt = new Date(Date.now() - minutes(120));
    return FocusSession.create({
      userId: new Types.ObjectId(), mode: 'deep_work', status: 'running', startedAt, lastResumedAt: startedAt,
      lastHeartbeatAt: startedAt, plannedDurationMinutes: 25, ...over,
    });
  }

  it('abandons stale running sessions, keeps fresh and paused ones, and is idempotent', async () => {
    const stale = await seed({});
    const fresh = await seed({ lastHeartbeatAt: new Date(Date.now() - minutes(2)) });
    const pausedRecently = await seed({ status: 'paused', lastHeartbeatAt: new Date(Date.now() - minutes(120)) });
    const done = await seed({ status: 'completed' });

    expect(await engine.reapStaleSessions()).toBe(1);
    expect((await FocusSession.findById(stale._id))!.status).toBe('abandoned');
    expect((await FocusSession.findById(stale._id))!.completedAt).toBeInstanceOf(Date);
    expect((await FocusSession.findById(fresh._id))!.status).toBe('running');
    expect((await FocusSession.findById(pausedRecently._id))!.status).toBe('paused');
    expect((await FocusSession.findById(done._id))!.status).toBe('completed');

    expect(await engine.reapStaleSessions()).toBe(0);
    expect((await FocusSession.findById(stale._id))!.status).toBe('abandoned');
  });

  it('reaps a paused session only after the longer paused window', async () => {
    const paused = await seed({ status: 'paused', lastHeartbeatAt: new Date(Date.now() - PAUSED_STALE_MS - minutes(1)) });
    expect(await engine.reapStaleSessions()).toBe(1);
    expect((await FocusSession.findById(paused._id))!.status).toBe('abandoned');
  });

  it('falls back to startedAt for sessions that predate lastHeartbeatAt', async () => {
    const legacy = await seed({});
    await FocusSession.collection.updateOne({ _id: legacy._id }, { $unset: { lastHeartbeatAt: '' } });
    expect(await engine.reapStaleSessions()).toBe(1);
    expect((await FocusSession.findById(legacy._id))!.status).toBe('abandoned');
  });

  it('clears the runtime-state context of the reaped session only', async () => {
    const stale = await seed({});
    const other = await seed({ lastHeartbeatAt: new Date() });
    const ctx = (id: Types.ObjectId) => ({ isActive: true, sessionId: id.toString(), status: 'running', duration: 25, mode: 'deep_work' });
    await UnifiedRuntimeState.create({ userId: stale.userId, sessionContext: ctx(stale._id) });
    await UnifiedRuntimeState.create({ userId: other.userId, sessionContext: ctx(other._id) });

    await engine.reapStaleSessions();
    expect((await UnifiedRuntimeState.findOne({ userId: stale.userId }))!.sessionContext)
      .toMatchObject({ isActive: false, status: 'abandoned' });
    expect((await UnifiedRuntimeState.findOne({ userId: other.userId }))!.sessionContext)
      .toMatchObject({ isActive: true, status: 'running' });
  });

  it('heals at session start: a stale session of the same user no longer blocks a new one', async () => {
    const stale = await seed({ userId: new Types.ObjectId(userId) });
    expect(await FocusSession.countDocuments({ userId, status: 'running' })).toBe(1);
    const started = await post('/focus/start', { duration: 25, mode: 'deep_work' });
    expect(started.status).toBe(200);
    expect((await FocusSession.findById(stale._id))!.status).toBe('abandoned');
    expect(await FocusSession.countDocuments({ userId, status: 'running' })).toBe(1);
  });

  it('a heartbeat keeps a session alive past the stale window', async () => {
    const { sessionId } = await engine.startSession(userId, 'deep_work', 25);
    await FocusSession.updateOne({ _id: sessionId }, { $set: { lastHeartbeatAt: new Date(Date.now() - RUNNING_STALE_MS - 1000) } });
    await engine.recordHeartbeat(sessionId, userId);
    expect(await engine.reapStaleSessions()).toBe(0);
    expect((await FocusSession.findById(sessionId))!.status).toBe('running');
  });
});
