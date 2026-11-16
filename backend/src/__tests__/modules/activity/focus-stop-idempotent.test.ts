import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  User, UserXp, XpTransaction, FocusSession, ActivityEvent, UserStreakLog, Mission,
} from '../../../db/models/index.js';
import activityRoutes from '../../../modules/activity/activity.routes.js';
import { errorHandler } from '../../../middleware/error.js';
import { FocusEngine } from '../../../modules/activity/focusEngine.service.js';

const fixture = vi.hoisted(() => ({ verify: vi.fn(), queued: [] as Array<{ name: string; data: Record<string, unknown> }> }));

// Keep auth middleware, routes, controller, focus engine, runtime state, streak service,
// XP processor and MongoDB real. The queue runs the XP processor inline, so the real
// XpTransaction unique index decides whether an award is a duplicate.
vi.mock('@clerk/backend', () => ({ verifyToken: fixture.verify }));
vi.mock('../../../services/auth/ClerkUserSyncService.js', () => ({ syncClerkUser: vi.fn() }));
vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: {
    emitXpUpdated: vi.fn(), emitLevelUp: vi.fn(), emitStreakMilestone: vi.fn(), emitStreakAtRisk: vi.fn(),
    emitRuntimeStatePatch: vi.fn(), emitMissionProgress: vi.fn(), emitNotificationCreated: vi.fn(),
  },
}));
vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    invalidateAllUserCache: vi.fn(), invalidateUserStreak: vi.fn(), invalidateDashboard: vi.fn(),
  },
}));
vi.mock('../../../shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../shared/jobs/index.js', () => ({
  getXpProcessingQueue: () => ({
    add: async (name: string, data: Record<string, unknown>) => {
      fixture.queued.push({ name, data });
      if (data.sourceType === 'focus_session') {
        const { processXpEvent } = await import('../../../modules/xp/processor.js');
        await processXpEvent(data as never);
      }
      return {};
    },
  }),
}));

const userId = '000000000000000000000055';
let server: Server;
let base: string;

beforeAll(async () => {
  await Promise.all([User.init(), UserXp.init(), XpTransaction.init(), FocusSession.init(), UserStreakLog.init()]);
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
  fixture.queued.length = 0;
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_focus_stop');
  fixture.verify.mockResolvedValue({ sub: 'clerk_focus_user' });
  await User.create({ _id: userId, clerkId: 'clerk_focus_user', username: 'focususer', email: 'focus@example.test',
    displayName: 'Focus User', timezone: 'UTC' });
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
  return { status: response.status, body: await response.json() as { message?: string; data?: Record<string, unknown> } };
}

async function seedQualifyingTimer(sessionId: string) {
  await FocusSession.updateOne({ _id: sessionId }, {
    $set: { lastResumedAt: new Date(Date.now() - 25 * 60_000), coveredHeartbeatIntervals: 24 },
  });
}

async function expectNoAward() {
  expect(fixture.queued).toHaveLength(0);
  expect(await XpTransaction.countDocuments({ userId, sourceType: 'focus_session' })).toBe(0);
  expect((await UserXp.findOne({ userId }))!.totalXp).toBe(0);
  expect(await ActivityEvent.countDocuments({ userId, type: 'focus_session' })).toBe(0);
  expect(await UserStreakLog.countDocuments({ userId, streakType: 'focus' })).toBe(0);
}

describe('POST /activity/focus/stop', () => {
  it('awards nothing when no session was ever started', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await post('/focus/stop');
      expect(res.status).toBe(200);
    }
    await expectNoAward();
  });

  it('awards exactly once for one session when stop is replayed', async () => {
    expect((await post('/focus/start', { duration: 25, mode: 'deep_work' })).status).toBe(200);
    const sessionId = (await FocusSession.findOne({ userId }))!._id.toString();

    await seedQualifyingTimer(sessionId);
    const first = await post('/focus/stop');
    expect(first.status).toBe(200);
    expect(first.body.message).toBe('Focus session stopped and recorded');
    for (let i = 0; i < 3; i++) {
      const replay = await post('/focus/stop');
      expect(replay.status).toBe(200);
      expect(replay.body.message).toBe('No running focus session to stop');
    }

    expect(fixture.queued).toHaveLength(1);
    expect(fixture.queued[0].data).toMatchObject({ userId, sourceType: 'focus_session', sourceId: `focus_${sessionId}` });
    const ledger = await XpTransaction.find({ userId, sourceType: 'focus_session' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].xpAwarded).toBe(50);
    expect((await UserXp.findOne({ userId }))!.totalXp).toBe(50);
    expect(await ActivityEvent.countDocuments({ userId, type: 'focus_session' })).toBe(1);
    const logs = await UserStreakLog.find({ userId, streakType: 'focus' });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ activityCount: 1, sources: [`focus_${sessionId}`] });
    expect((await FocusSession.findById(sessionId))!.status).toBe('completed');
  });

  it('awards nothing for a cancelled session', async () => {
    await post('/focus/start', { duration: 25, mode: 'deep_work' });
    expect((await post('/focus/cancel')).status).toBe(200);
    expect((await post('/focus/stop')).status).toBe(200);
    await expectNoAward();
  });

  it('awards each of two separate sessions once', async () => {
    for (let i = 0; i < 2; i++) {
      await post('/focus/start', { duration: 25, mode: 'deep_work' });
      const live = await FocusSession.findOne({ userId, status: 'running' });
      await seedQualifyingTimer(live!._id.toString());
      await post('/focus/stop');
      await post('/focus/stop');
    }
    expect(await XpTransaction.countDocuments({ userId, sourceType: 'focus_session' })).toBe(2);
    expect((await UserXp.findOne({ userId }))!.totalXp).toBe(100);
  });

  it('records a quick stop without awarding XP', async () => {
    await post('/focus/start', { duration: 25, mode: 'deep_work' });
    expect((await post('/focus/stop')).status).toBe(200);
    expect(await XpTransaction.countDocuments({ userId, sourceType: 'focus_session' })).toBe(0);
    expect(await ActivityEvent.countDocuments({ userId, type: 'focus_session' })).toBe(1);
    expect(await UserStreakLog.countDocuments({ userId, streakType: 'focus' })).toBe(1);
  });

  it('keeps recording focus streak and mission progress after the cap', async () => {
    for (let i = 0; i < 4; i++) {
      await post('/focus/start', { duration: 25, mode: 'deep_work' });
      const live = await FocusSession.findOne({ userId, status: 'running' });
      await seedQualifyingTimer(live!._id.toString());
      expect((await post('/focus/stop')).status).toBe(200);
    }
    const mission = await Mission.create({
      userId, title: 'Maintain your streak', description: 'Complete an activity', type: 'daily',
      category: 'consistency', targetCount: 1, xpReward: 20, expiresAt: new Date(Date.now() + 60_000),
    });
    await post('/focus/start', { duration: 25, mode: 'deep_work' });
    const live = await FocusSession.findOne({ userId, status: 'running' });
    await seedQualifyingTimer(live!._id.toString());
    expect((await post('/focus/stop')).status).toBe(200);

    expect(await XpTransaction.countDocuments({ userId, sourceType: 'focus_session' })).toBe(4);
    expect((await UserXp.findOne({ userId }))!.totalXp).toBe(220);
    expect(await Mission.findById(mission._id)).toMatchObject({ currentCount: 1, status: 'completed' });
    expect(await UserStreakLog.findOne({ userId, streakType: 'focus' })).toMatchObject({ activityCount: 5 });
  });

  it('enforces the UTC completion-day cap for concurrent delayed jobs', async () => {
    const { processXpEvent } = await import('../../../modules/xp/processor.js');
    const createCompleted = (completedAt: string) => FocusSession.create({
      userId, mode: 'deep_work', status: 'completed', plannedDurationMinutes: 25,
      completedAt: new Date(completedAt), startedAt: new Date(Date.parse(completedAt) - 1_500_000),
      activeDurationMs: 1_500_000, coveredHeartbeatIntervals: 25,
    });
    const sessions = await Promise.all(Array.from({ length: 5 }, () => createCompleted('2026-01-01T23:59:59Z')));
    const nextDay = await createCompleted('2026-01-02T00:00:00Z');
    const award = (sessionId: string) => processXpEvent({
      userId, sourceType: 'focus_session', sourceId: `focus_${sessionId}`, metadata: { xpReward: 500 },
    });

    const results = await Promise.all(sessions.map(focus => award(focus._id.toString())));
    expect(results.map(result => result.xpAwarded).sort()).toEqual([0, 50, 50, 50, 50]);
    expect((await award(nextDay._id.toString())).xpAwarded).toBe(50);
    expect((await award(new Types.ObjectId().toString())).awarded).toBe(false);
    expect((await UserXp.findOne({ userId }))!.totalXp).toBe(250);
  });

  it('lets only one of several overlapping stops award', async () => {
    await post('/focus/start', { duration: 25, mode: 'deep_work' });
    const live = await FocusSession.findOne({ userId, status: 'running' });
    await seedQualifyingTimer(live!._id.toString());
    const results = await Promise.all([post('/focus/stop'), post('/focus/stop'), post('/focus/stop')]);
    expect(results.every(r => r.status === 200)).toBe(true);
    expect(await XpTransaction.countDocuments({ userId, sourceType: 'focus_session' })).toBe(1);
    expect(await ActivityEvent.countDocuments({ userId, type: 'focus_session' })).toBe(1);
    expect(await UserStreakLog.countDocuments({ userId, streakType: 'focus' })).toBe(1);
  });
});

describe('FocusEngine.completeSession', () => {
  it('counts distinct active heartbeat intervals and excludes paused heartbeats', async () => {
    const engine = new FocusEngine();
    const { sessionId } = await engine.startSession(userId, 'deep_work', 25);
    await FocusSession.updateOne({ _id: sessionId }, { $set: { lastResumedAt: new Date(Date.now() - 30_000) } });
    await Promise.all([engine.recordHeartbeat(sessionId, userId), engine.recordHeartbeat(sessionId, userId)]);
    expect(await FocusSession.findById(sessionId)).toMatchObject({ heartbeatCount: 2, coveredHeartbeatIntervals: 1 });

    await engine.pauseSession(sessionId, userId);
    await engine.recordHeartbeat(sessionId, userId);
    expect(await FocusSession.findById(sessionId)).toMatchObject({ heartbeatCount: 3, coveredHeartbeatIntervals: 1 });

    await engine.resumeSession(sessionId, userId);
    await FocusSession.updateOne({ _id: sessionId }, { $set: { lastResumedAt: new Date(Date.now() - 60_000) } });
    await engine.recordHeartbeat(sessionId, userId);
    expect(await FocusSession.findById(sessionId)).toMatchObject({ heartbeatCount: 4, coveredHeartbeatIntervals: 2 });
  });

  it('returns a result for only one of two concurrent completions', async () => {
    const engine = new FocusEngine();
    const owner = new Types.ObjectId().toString();
    const { sessionId } = await engine.startSession(owner, 'deep_work', 25);
    const results = await Promise.all([engine.completeSession(sessionId, owner), engine.completeSession(sessionId, owner)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await engine.completeSession(sessionId, owner)).toBeNull();
  });
});
