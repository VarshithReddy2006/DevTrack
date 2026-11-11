import { afterEach, expect, it, vi } from 'vitest';
import { User, UserAnalytics, UserStreakLog } from '../../db/models/index.js';
import { runStreakAtRiskCheck } from '../../shared/jobs/maintenanceWorker.js';
import { getNotificationQueue } from '../../shared/jobs/queueFactory.js';

vi.mock('../../shared/jobs/queueFactory.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../shared/jobs/queueFactory.js')>();
  const add = vi.fn().mockResolvedValue(undefined);
  return { ...actual, getNotificationQueue: () => ({ add }) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each([
  ['America/Los_Angeles', '2026-11-02T01:00:00Z', '2026-11-02T07:00:00Z', '2026-11-01'],
  ['UTC', '2026-10-28T17:00:00Z', '2026-10-28T23:00:00Z', '2026-10-28'],
  ['Asia/Kolkata', '2026-10-28T12:00:00Z', '2026-10-28T17:45:00Z', '2026-10-28'],
  ['invalid/timezone', '2026-10-28T17:00:00Z', '2026-10-28T23:00:00Z', '2026-10-28'],
])('checks local eligibility and uses one daily queue key for %s', async (timezone, early, late, dateKey) => {
  const today = new Date(`${dateKey}T00:00:00Z`);
  const yesterday = new Date(today.getTime() - 86_400_000);
  const staleDay = new Date(yesterday.getTime() - 86_400_000);
  const users = await User.create(['at-risk', 'active', 'expired', 'inactive'].map(username => ({
    username, timezone, clerkId: username, displayName: username, email: `${username}@example.test`,
  })));
  await UserAnalytics.create(users.map((user, index) => ({
    userId: user._id, currentStreak: index === 3 ? 0 : 1,
  })));
  await UserStreakLog.create(users.map((user, index) => ({
    userId: user._id, date: [yesterday, today, staleDay, yesterday][index],
    streakType: 'focus', activityCount: 1, timezone,
  })));
  // An active user can have yesterday's log as well.
  await UserStreakLog.create({
    userId: users[1]._id, date: yesterday, streakType: 'github', activityCount: 1, timezone,
  });

  const add = getNotificationQueue().add;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(early));
  await runStreakAtRiskCheck();
  expect(add).not.toHaveBeenCalled();

  vi.setSystemTime(new Date(late));
  await runStreakAtRiskCheck();
  vi.setSystemTime(new Date(new Date(late).getTime() + 30 * 60_000));
  await runStreakAtRiskCheck();
  expect(add).toHaveBeenCalledTimes(2);
  const userId = users[0]._id.toString();
  const id = `streak-risk-${userId}-${dateKey}`;
  for (const call of [1, 2]) {
    expect(add).toHaveBeenNthCalledWith(call, 'streak-at-risk', {
      type: 'streak_at_risk', userId, data: { currentStreak: 1 },
    }, { jobId: id, deduplication: { id, ttl: 72 * 60 * 60_000 } });
  }

  await UserAnalytics.updateOne({ userId: users[2]._id }, {
    streakFreezeUntil: new Date(new Date(late).getTime() + 60 * 60_000),
  });
  vi.clearAllMocks();
  await runStreakAtRiskCheck();
  expect(add).toHaveBeenCalledWith('streak-at-risk', {
    type: 'streak_at_risk', userId: users[2]._id.toString(), data: { currentStreak: 1 },
  }, expect.anything());
});
