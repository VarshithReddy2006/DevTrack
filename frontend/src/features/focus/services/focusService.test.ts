import { beforeEach, describe, expect, it, vi } from 'vitest';
import axiosClient from '../../../utils/axiosClient';
import { focusService } from './focusService';

vi.mock('../../../utils/axiosClient', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

const respond = (data: unknown) => vi.mocked(axiosClient.get).mockResolvedValue({ data: { success: true, data } });
beforeEach(() => { vi.resetAllMocks(); });

// Payload shapes of GET /activity/focus/summary and /activity/focus/history.
const summary = {
  totalSessions: 0, completedSessions: 0, abandonedSessions: 0, totalDurationMinutes: 0, averageQualityScore: 0, modeBreakdown: {},
  today: { date: '2026-01-02', completedSessions: 0, totalDurationMinutes: 0 }, currentStreak: 0,
};
const session = {
  id: 'a', mode: 'deep_work', status: 'completed', plannedDurationMinutes: 50, actualDurationMinutes: 50, activeDurationMs: 3_000_000,
  focusQualityScore: 80, startedAt: '2026-01-02T10:00:00.000Z', completedAt: '2026-01-02T10:50:00.000Z', heartbeatCount: 50,
  xpAwarded: 50, xpReason: 'qualified',
};

describe('focusService.getTodaySummary', () => {
  it('shows zeros for a user with nothing today', async () => {
    respond(summary);
    expect(await focusService.getTodaySummary()).toEqual({ todayMinutes: 0, completedSessionsToday: 0, currentStreak: 0 });
  });

  it('reads the totals of the current day', async () => {
    respond({ ...summary, today: { date: '2026-01-02', completedSessions: 3, totalDurationMinutes: 95 }, currentStreak: 6 });
    expect(await focusService.getTodaySummary()).toEqual({ todayMinutes: 95, completedSessionsToday: 3, currentStreak: 6 });
  });

  it('rejects when the request fails instead of returning numbers', async () => {
    vi.mocked(axiosClient.get).mockRejectedValue(new Error('offline'));
    await expect(focusService.getTodaySummary()).rejects.toThrow('offline');
  });
});

describe('focusService.getHistory', () => {
  it('lists the sessions with their real duration and XP', async () => {
    const reaped = { ...session, id: 'b', status: 'abandoned', actualDurationMinutes: 0, activeDurationMs: 420_000, xpAwarded: null, xpReason: null };
    respond({ sessions: [session, reaped], total: 2, limit: 30, offset: 0 });
    expect(await focusService.getHistory(30)).toEqual([
      { id: 'a', mode: 'deep_work', status: 'completed', durationMinutes: 50, startedAt: session.startedAt, xpAwarded: 50, xpReason: 'qualified' },
      { id: 'b', mode: 'deep_work', status: 'abandoned', durationMinutes: 7, startedAt: session.startedAt, xpAwarded: null, xpReason: undefined },
    ]);
  });

  it('rejects when the request fails instead of looking empty', async () => {
    vi.mocked(axiosClient.get).mockRejectedValue(new Error('offline'));
    await expect(focusService.getHistory()).rejects.toThrow('offline');
  });
});
