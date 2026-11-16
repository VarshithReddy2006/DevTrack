// ============================================================================
// focus-routes.test.ts — Integration tests for Server-Authoritative Focus Sessions
// ============================================================================

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { User, FocusSession } from '../../../db/models/index.js';
import focusRoutes from '../../../modules/activity/focus.routes.js';
import { errorHandler } from '../../../middleware/error.js';

const fixture = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock('@clerk/backend', () => ({ verifyToken: fixture.verify }));
vi.mock('../../../services/auth/ClerkUserSyncService.js', () => ({ syncClerkUser: vi.fn() }));
vi.mock('../../../shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const userAId = '000000000000000000000081';
const userBId = '000000000000000000000082';

let server: Server;
let base: string;

beforeAll(async () => {
  await Promise.all([User.init(), FocusSession.init()]);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/focus/sessions', focusRoutes);
  app.use(errorHandler);

  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1');
    listener.once('error', reject);
    listener.once('listening', () => resolve(listener));
  });

  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/focus/sessions`;
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_focus_routes');

  fixture.verify.mockImplementation(async (token: string) => {
    if (token === 'token_user_a') return { sub: 'clerk_user_a' };
    if (token === 'token_user_b') return { sub: 'clerk_user_b' };
    throw new Error('Invalid token');
  });

  await User.create([
    {
      _id: userAId,
      clerkId: 'clerk_user_a',
      username: 'usera',
      email: 'a@example.test',
      displayName: 'User A',
      timezone: 'UTC',
    },
    {
      _id: userBId,
      clerkId: 'clerk_user_b',
      username: 'userb',
      email: 'b@example.test',
      displayName: 'User B',
      timezone: 'UTC',
    },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function request(path: string, options: { token?: string; method?: string; body?: unknown } = {}) {
  const { token = 'token_user_a', method = 'GET', body } = options;
  return fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('Server-Authoritative Focus Session Routes', () => {
  it('starts a new focus session and retrieves it via GET /active', async () => {
    const startRes = await request('/', {
      method: 'POST',
      body: { mode: 'deep_work', plannedDurationMinutes: 30 },
    });

    expect(startRes.status).toBe(201);
    const startData = await startRes.json();
    expect(startData.success).toBe(true);
    expect(startData.data.mode).toBe('deep_work');
    expect(startData.data.isOpen).toBe(true);
    expect(startData.data.plannedDurationMinutes).toBe(30);

    const sessionId = startData.data._id || startData.data.sessionId;

    // Check GET /active
    const activeRes = await request('/active');
    expect(activeRes.status).toBe(200);
    const activeData = await activeRes.json();
    expect(activeData.success).toBe(true);
    expect(activeData.data._id).toBe(sessionId);
    expect(activeData.data.isOpen).toBe(true);
  });

  it('enforces single open session constraint: rejects second start with 409 and open session data', async () => {
    // Start session 1
    const firstRes = await request('/', {
      method: 'POST',
      body: { mode: 'deep_work', plannedDurationMinutes: 25 },
    });
    expect(firstRes.status).toBe(201);
    const firstData = await firstRes.json();
    const sessionId = firstData.data._id || firstData.data.sessionId;

    // Attempt second session start while first is open
    const secondRes = await request('/', {
      method: 'POST',
      body: { mode: 'backend', plannedDurationMinutes: 45 },
    });

    expect(secondRes.status).toBe(409);
    const secondData = await secondRes.json();
    expect(secondData.success).toBe(false);
    expect(secondData.code).toBe('FOCUS_SESSION_ALREADY_OPEN');
    expect(secondData.data).toBeDefined();
    expect(String(secondData.data._id)).toBe(String(sessionId));
  });

  it('records heartbeat and throttles heartbeats sent under 45 seconds', async () => {
    const startRes = await request('/', {
      method: 'POST',
      body: { mode: 'deep_work', plannedDurationMinutes: 25 },
    });
    const { data } = await startRes.json();
    const sessionId = data._id || data.sessionId;

    // Immediate heartbeat (< 45s since session start / last heartbeat)
    const fastHeartbeatRes = await request(`/${sessionId}/heartbeat`, { method: 'POST' });
    expect(fastHeartbeatRes.status).toBe(429);
    const fastHeartbeatData = await fastHeartbeatRes.json();
    expect(fastHeartbeatData.code).toBe('HEARTBEAT_TOO_FREQUENT');

    // Manually age the lastHeartbeatAt by 50 seconds in DB to simulate 60s ping
    await FocusSession.updateOne(
      { _id: sessionId },
      { $set: { lastHeartbeatAt: new Date(Date.now() - 50_000) } }
    );

    // Heartbeat after 50 seconds should succeed
    const validHeartbeatRes = await request(`/${sessionId}/heartbeat`, { method: 'POST' });
    expect(validHeartbeatRes.status).toBe(200);
    const validHeartbeatData = await validHeartbeatRes.json();
    expect(validHeartbeatData.success).toBe(true);
    expect(validHeartbeatData.data.heartbeatCount).toBe(1);
  });

  it('tracks pause and resume intervals and accurately calculates activeSec', async () => {
    const startedAt = new Date(Date.now() - 600_000); // 10 minutes ago
    const session = await FocusSession.create({
      userId: userAId,
      mode: 'deep_work',
      status: 'running',
      isOpen: true,
      startedAt,
      lastResumedAt: startedAt,
      lastHeartbeatAt: startedAt,
      plannedDurationMinutes: 25,
      plannedSec: 1500,
      activeSec: 600,
      pauses: [],
    });

    const sessionId = session._id.toString();

    // Pause the session
    const pauseRes = await request(`/${sessionId}/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(200);
    const pauseData = await pauseRes.json();
    expect(pauseData.data.status).toBe('paused');
    expect(pauseData.data.pauses.length).toBe(1);
    expect(pauseData.data.pauses[0].endedAt).toBeNull();

    // Simulate 3 minutes paused by aging the pause start
    const pauseStart = new Date(Date.now() - 180_000);
    await FocusSession.updateOne(
      { _id: sessionId },
      { $set: { 'pauses.0.startedAt': pauseStart } }
    );

    // Resume the session
    const resumeRes = await request(`/${sessionId}/resume`, { method: 'POST' });
    expect(resumeRes.status).toBe(200);
    const resumeData = await resumeRes.json();
    expect(resumeData.data.status).toBe('running');
    expect(resumeData.data.pauses[0].endedAt).not.toBeNull();

    // Verify active time: 10 minutes (600s) wall clock minus 3 minutes (180s) pause = ~420s
    expect(resumeData.data.activeSec).toBeGreaterThanOrEqual(420);
    expect(resumeData.data.activeSec).toBeLessThanOrEqual(430);
  });

  it('enforces ownership: returns 404 when user attempts to access another user session', async () => {
    // User A creates a session
    const sessionA = await FocusSession.create({
      userId: userAId,
      mode: 'deep_work',
      status: 'running',
      isOpen: true,
      startedAt: new Date(),
      plannedDurationMinutes: 25,
      plannedSec: 1500,
      pauses: [],
    });

    const sessionAId = sessionA._id.toString();

    // User B attempts to heartbeat User A's session -> must return 404, NEVER 403
    const bHeartbeat = await request(`/${sessionAId}/heartbeat`, {
      token: 'token_user_b',
      method: 'POST',
    });
    expect(bHeartbeat.status).toBe(404);

    // User B attempts to pause User A's session -> 404
    const bPause = await request(`/${sessionAId}/pause`, {
      token: 'token_user_b',
      method: 'POST',
    });
    expect(bPause.status).toBe(404);

    // User B attempts to resume User A's session -> 404
    const bResume = await request(`/${sessionAId}/resume`, {
      token: 'token_user_b',
      method: 'POST',
    });
    expect(bResume.status).toBe(404);

    // User B attempts to complete User A's session -> 404
    const bComplete = await request(`/${sessionAId}/complete`, {
      token: 'token_user_b',
      method: 'POST',
    });
    expect(bComplete.status).toBe(404);

    // User B attempts to abandon User A's session -> 404
    const bAbandon = await request(`/${sessionAId}/abandon`, {
      token: 'token_user_b',
      method: 'POST',
    });
    expect(bAbandon.status).toBe(404);
  });

  it('abandons a session, setting status: abandoned and isOpen: false', async () => {
    const startRes = await request('/', {
      method: 'POST',
      body: { mode: 'debug', plannedDurationMinutes: 25 },
    });
    const { data } = await startRes.json();
    const sessionId = data._id || data.sessionId;

    const abandonRes = await request(`/${sessionId}/abandon`, { method: 'POST' });
    expect(abandonRes.status).toBe(200);
    const abandonData = await abandonRes.json();
    expect(abandonData.data.status).toBe('abandoned');
    expect(abandonData.data.isOpen).toBe(false);

    // After abandonment, user can immediately start a new session
    const newStartRes = await request('/', {
      method: 'POST',
      body: { mode: 'deep_work', plannedDurationMinutes: 25 },
    });
    expect(newStartRes.status).toBe(201);
  });

  it('completes a session, closing pauses, computing quality score, and setting isOpen: false', async () => {
    const startedAt = new Date(Date.now() - 1500_000); // 25 minutes ago
    const session = await FocusSession.create({
      userId: userAId,
      mode: 'deep_work',
      status: 'running',
      isOpen: true,
      startedAt,
      lastResumedAt: startedAt,
      lastHeartbeatAt: startedAt,
      plannedDurationMinutes: 25,
      plannedSec: 1500,
      heartbeatCount: 20,
      pauses: [],
    });

    const sessionId = session._id.toString();

    const completeRes = await request(`/${sessionId}/complete`, { method: 'POST' });
    expect(completeRes.status).toBe(200);
    const completeData = await completeRes.json();
    expect(completeData.success).toBe(true);

    const doc = await FocusSession.findById(sessionId);
    expect(doc!.status).toBe('completed');
    expect(doc!.isOpen).toBe(false);
    expect(doc!.completedAt).toBeDefined();
    expect(doc!.actualDurationMinutes).toBeGreaterThanOrEqual(24);
    expect(doc!.focusQualityScore).toBeGreaterThan(0);
  });
});
