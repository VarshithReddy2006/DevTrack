import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { FocusSession, User, UserStreakLog } from '../../../db/models/index.js';
import { focusEngine } from '../../../modules/activity/focusEngine.service.js';
import { localDateString, localDayBounds } from '../../../shared/date.js';

const MINUTE = 60_000;

const session = (userId: Types.ObjectId, completedAt: Date, minutes: number, extra: Record<string, unknown> = {}) => ({
  userId, status: 'completed', isOpen: false, mode: 'deep_work',
  startedAt: new Date(completedAt.getTime() - minutes * MINUTE), completedAt,
  plannedDurationMinutes: minutes, actualDurationMinutes: minutes, activeDurationMs: minutes * MINUTE, ...extra,
});

describe('focus summary for the current day', () => {
  // Zones far apart, so at least one of them is on a different date than UTC.
  it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata'])('counts completed sessions of the local day in %s', async (timezone) => {
    const user = await User.create({ clerkId: 'synthetic-focus', username: 'focuser', email: 'focus@example.test', displayName: 'F', timezone });
    const today = localDateString(new Date(), timezone);
    const { start } = localDayBounds(today, timezone);
    await FocusSession.create([
      session(user._id, new Date(start.getTime() + MINUTE), 25),
      session(user._id, new Date(start.getTime() + 2 * MINUTE), 50),
      session(user._id, new Date(start.getTime() - MINUTE), 90), // yesterday, inside the rolling 24 hours
      session(user._id, new Date(start.getTime() + 3 * MINUTE), 15, { status: 'abandoned' }),
      session(new Types.ObjectId(), new Date(start.getTime() + MINUTE), 40),
    ]);

    const summary = await focusEngine.getUserFocusSummary(user._id.toString(), 1);

    expect(summary.today).toEqual({ date: today, completedSessions: 2, totalDurationMinutes: 75 });
  });

  it('reports zeros for a user without any session', async () => {
    const summary = await focusEngine.getUserFocusSummary(new Types.ObjectId().toString(), 1);
    expect(summary).toMatchObject({ today: { completedSessions: 0, totalDurationMinutes: 0 }, currentStreak: 0 });
  });

  it('reports the same current streak as the rest of the app', async () => {
    const userId = new Types.ObjectId();
    const todayUtc = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    await UserStreakLog.create([0, 1, 2].map(daysAgo => ({
      userId, streakType: 'dsa', activityCount: 1, date: new Date(todayUtc.getTime() - daysAgo * 86_400_000),
    })));
    expect((await focusEngine.getUserFocusSummary(userId.toString(), 1)).currentStreak).toBe(3);
  });

  it('returns the stored XP decision with each history item, and null when there is none', async () => {
    const userId = new Types.ObjectId();
    const now = Date.now();
    await FocusSession.create([
      session(userId, new Date(now), 25, { xp: { amount: 50, reason: 'qualified', capApplied: false } }),
      session(userId, new Date(now - 60 * MINUTE), 10, { status: 'abandoned' }),
    ]);

    const { sessions } = await focusEngine.getUserFocusHistory(userId.toString());

    expect(sessions.map(s => [s.xpAwarded, s.xpReason])).toEqual([[50, 'qualified'], [null, null]]);
  });
});
