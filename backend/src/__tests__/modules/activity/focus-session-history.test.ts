// src/__tests__/modules/activity/focus-session-history.test.ts
// Unit tests for focus session history pagination, filtering, and summary analytics

import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { FocusSession } from '../../../db/models/index.js';
import { focusEngine } from '../../../modules/activity/focusEngine.service.js';

describe('Focus Session History & Summary Analytics', () => {
  const userId = new Types.ObjectId().toHexString();
  const foreignUserId = new Types.ObjectId().toHexString();

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
  });
});
