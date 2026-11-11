// src/__tests__/modules/activity/focus-session-history.test.ts
// Unit tests for focus session history pagination, filtering, and summary analytics

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Types } from 'mongoose';
import { FocusSession } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import { focusEngine } from '../../../modules/activity/focusEngine.service.js';

const testIds = vi.hoisted(() => ({
  userId: '000000000000000000000001',
  foreignUserId: '000000000000000000000002',
}));

vi.mock('../../../middleware/index.js', async () => {
  const { validateBody, validateParams } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    validateBody,
    validateParams,
    asyncHandler,
    authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const auth = req.get('authorization');
      if (auth === 'Bearer owner-token') {
        Object.assign(req, { user: { id: testIds.userId } });
        next();
        return;
      }
      if (auth === 'Bearer other-token') {
        Object.assign(req, { user: { id: testIds.foreignUserId } });
        next();
        return;
      }
      commonErrors.unauthorized(res);
    },
  };
});

import activityRoutes from '../../../modules/activity/activity.routes.js';

describe('Focus Session History & Summary Analytics', () => {
  const userId = testIds.userId;
  const foreignUserId = testIds.foreignUserId;

  beforeEach(async () => {
    await FocusSession.deleteMany({});
  });

  describe('getUserFocusHistory', () => {
    it('returns paginated focus sessions with status and mode filtering', async () => {
      const now = new Date();
      await FocusSession.create([
        {
          userId: new Types.ObjectId(userId),
          mode: 'pomodoro',
          status: 'completed',
          plannedDurationMinutes: 25,
          actualDurationMinutes: 25,
          activeDurationMs: 1500000,
          focusQualityScore: 90,
          startedAt: new Date(now.getTime() - 3600000),
          completedAt: new Date(now.getTime() - 2100000),
        },
        {
          userId: new Types.ObjectId(userId),
          mode: 'deepwork',
          status: 'abandoned',
          plannedDurationMinutes: 50,
          actualDurationMinutes: 10,
          activeDurationMs: 600000,
          focusQualityScore: null,
          startedAt: new Date(now.getTime() - 7200000),
          completedAt: new Date(now.getTime() - 6600000),
        },
        {
          userId: new Types.ObjectId(userId),
          mode: 'pomodoro',
          status: 'completed',
          plannedDurationMinutes: 25,
          actualDurationMinutes: 25,
          activeDurationMs: 1500000,
          focusQualityScore: 80,
          startedAt: new Date(now.getTime() - 1800000),
          completedAt: now,
        },
        {
          userId: new Types.ObjectId(foreignUserId),
          mode: 'pomodoro',
          status: 'completed',
          plannedDurationMinutes: 25,
          actualDurationMinutes: 25,
          activeDurationMs: 1500000,
          focusQualityScore: 100,
          startedAt: now,
        },
      ]);

      const all = await focusEngine.getUserFocusHistory(userId);
      expect(all.total).toBe(3);
      expect(all.sessions).toHaveLength(3);

      const pomodoroOnly = await focusEngine.getUserFocusHistory(userId, { mode: 'pomodoro' });
      expect(pomodoroOnly.total).toBe(2);
      expect(pomodoroOnly.sessions.every((s) => s.mode === 'pomodoro')).toBe(true);

      const completedOnly = await focusEngine.getUserFocusHistory(userId, { status: 'completed' });
      expect(completedOnly.total).toBe(2);
      expect(completedOnly.sessions.every((s) => s.status === 'completed')).toBe(true);

      const paginated = await focusEngine.getUserFocusHistory(userId, { limit: 1, offset: 0 });
      expect(paginated.total).toBe(3);
      expect(paginated.sessions).toHaveLength(1);
      expect(paginated.limit).toBe(1);
      expect(paginated.offset).toBe(0);
    });
  });

  describe('getUserFocusSummary', () => {
    it('aggregates total sessions, duration, average quality score, and mode breakdown', async () => {
      const now = new Date();
      await FocusSession.create([
        {
          userId: new Types.ObjectId(userId),
          mode: 'pomodoro',
          status: 'completed',
          plannedDurationMinutes: 25,
          actualDurationMinutes: 25,
          activeDurationMs: 1500000,
          focusQualityScore: 90,
          startedAt: new Date(now.getTime() - 3600000),
          completedAt: new Date(now.getTime() - 2100000),
        },
        {
          userId: new Types.ObjectId(userId),
          mode: 'pomodoro',
          status: 'completed',
          plannedDurationMinutes: 25,
          actualDurationMinutes: 25,
          activeDurationMs: 1500000,
          focusQualityScore: 80,
          startedAt: new Date(now.getTime() - 1800000),
          completedAt: now,
        },
        {
          userId: new Types.ObjectId(userId),
          mode: 'deepwork',
          status: 'abandoned',
          plannedDurationMinutes: 60,
          actualDurationMinutes: 15,
          activeDurationMs: 900000,
          focusQualityScore: null,
          startedAt: new Date(now.getTime() - 7200000),
          completedAt: new Date(now.getTime() - 6300000),
        },
      ]);

      const summary = await focusEngine.getUserFocusSummary(userId, 7);
      expect(summary.totalSessions).toBe(3);
      expect(summary.completedSessions).toBe(2);
      expect(summary.abandonedSessions).toBe(1);
      expect(summary.totalDurationMinutes).toBe(50);
      expect(summary.averageQualityScore).toBe(85); // (90 + 80) / 2
      expect(summary.modeBreakdown.pomodoro).toEqual({ sessions: 2, totalMinutes: 50 });
      expect(summary.modeBreakdown.deepwork).toEqual({ sessions: 1, totalMinutes: 0 });
    });

    it('returns zeroes when no focus sessions exist', async () => {
      const summary = await focusEngine.getUserFocusSummary(userId, 30);
      expect(summary.totalSessions).toBe(0);
      expect(summary.completedSessions).toBe(0);
      expect(summary.abandonedSessions).toBe(0);
      expect(summary.totalDurationMinutes).toBe(0);
      expect(summary.averageQualityScore).toBe(0);
      expect(summary.modeBreakdown).toEqual({});
    });

    it('falls back safely when NaN or negative numeric bounds are passed directly', async () => {
      const now = new Date();
      await FocusSession.create([
        {
          userId: new Types.ObjectId(userId),
          mode: 'pomodoro',
          status: 'completed',
          plannedDurationMinutes: 25,
          actualDurationMinutes: 25,
          activeDurationMs: 1500000,
          focusQualityScore: 80,
          startedAt: now,
          completedAt: now,
        },
        {
          userId: new Types.ObjectId(userId),
          mode: 'pomodoro',
          status: 'completed',
          plannedDurationMinutes: 25,
          actualDurationMinutes: 25,
          activeDurationMs: 1500000,
          focusQualityScore: 100,
          startedAt: new Date(now.getTime() - 60 * 86_400_000),
          completedAt: new Date(now.getTime() - 60 * 86_400_000),
        },
      ]);

      const history = await focusEngine.getUserFocusHistory(userId, { limit: Number.NaN, offset: Number.NaN });
      expect(history.limit).toBe(20);
      expect(history.offset).toBe(0);
      expect(history.sessions).toHaveLength(2);

      const summary = await focusEngine.getUserFocusSummary(userId, Number.NaN);
      expect(summary.totalSessions).toBe(1);
    });
  });

  describe('HTTP routes (/api/activity/focus/history & /summary)', () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use('/api/activity', activityRoutes);
      app.use(errorHandler);
      await new Promise<void>((resolve, reject) => {
        server = app.listen(0, '127.0.0.1', () => resolve());
        server.once('error', reject);
      });
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/activity`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('rejects unauthenticated requests with 401 and invalid query params with 400', async () => {
      const unauthHistory = await fetch(`${baseUrl}/focus/history`);
      expect(unauthHistory.status).toBe(401);

      const unauthSummary = await fetch(`${baseUrl}/focus/summary`);
      expect(unauthSummary.status).toBe(401);

      const headers = { Authorization: 'Bearer owner-token' };

      const badLimit = await fetch(`${baseUrl}/focus/history?limit=abc`, { headers });
      expect(badLimit.status).toBe(400);
      expect((await badLimit.json()).code).toBe('VALIDATION_ERROR');

      const badStatus = await fetch(`${baseUrl}/focus/history?status=invalid`, { headers });
      expect(badStatus.status).toBe(400);

      const arrayMode = await fetch(`${baseUrl}/focus/history?mode=pomodoro&mode=deepwork`, { headers });
      expect(arrayMode.status).toBe(400);

      const badDays = await fetch(`${baseUrl}/focus/summary?days=abc`, { headers });
      expect(badDays.status).toBe(400);

      const nonPositiveDays = await fetch(`${baseUrl}/focus/summary?days=0`, { headers });
      expect(nonPositiveDays.status).toBe(400);
    });

    it('serves caller-scoped history pagination and summary over HTTP', async () => {
      const now = new Date();
      await FocusSession.create([
        {
          userId: new Types.ObjectId(userId),
          mode: 'pomodoro',
          status: 'completed',
          plannedDurationMinutes: 25,
          actualDurationMinutes: 25,
          activeDurationMs: 1500000,
          focusQualityScore: 90,
          startedAt: new Date(now.getTime() - 1000),
          completedAt: now,
        },
        {
          userId: new Types.ObjectId(foreignUserId),
          mode: 'deepwork',
          status: 'completed',
          plannedDurationMinutes: 50,
          actualDurationMinutes: 50,
          activeDurationMs: 3000000,
          focusQualityScore: 100,
          startedAt: now,
          completedAt: now,
        },
      ]);

      const headers = { Authorization: 'Bearer owner-token' };

      const histRes = await fetch(`${baseUrl}/focus/history?status=completed&mode=pomodoro&limit=1&offset=0`, { headers });
      expect(histRes.status).toBe(200);
      const histJson = await histRes.json();
      expect(histJson.data.total).toBe(1);
      expect(histJson.data.sessions).toHaveLength(1);
      expect(histJson.data.sessions[0].mode).toBe('pomodoro');

      const sumRes = await fetch(`${baseUrl}/focus/summary?days=7`, { headers });
      expect(sumRes.status).toBe(200);
      const sumJson = await sumRes.json();
      expect(sumJson.data.totalSessions).toBe(1);
      expect(sumJson.data.totalDurationMinutes).toBe(25);
      expect(sumJson.data.averageQualityScore).toBe(90);
    });
  });
});
