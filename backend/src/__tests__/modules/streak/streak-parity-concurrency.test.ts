// src/__tests__/modules/streak/streak-parity-concurrency.test.ts
// Verifies streak parity between DashboardService and StreakService,
// atomic concurrent UserStreakLog upserts, and bounded DailyActivity arrays (issue #142).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import {
  recordActivity,
  getStreakStatus,
} from '../../../modules/streak/streak.service.js';
import {
  getStreakData,
  getDashboardStats,
} from '../../../modules/dashboard/dashboard.service.js';
import {
  incrementDailyActivity,
} from '../../../modules/activity/activity.service.js';
import {
  User,
  UserStreakLog,
  UserAnalytics,
  DailyActivity,
} from '../../../db/models/index.js';

vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: {
    emitStreakMilestone: vi.fn(),
    emitStreakAtRisk: vi.fn(),
    emitProjectCreated: vi.fn(),
    emitProjectUpdated: vi.fn(),
    emitProjectDeleted: vi.fn(),
    emitTaskCreated: vi.fn(),
    emitTaskUpdated: vi.fn(),
    emitTaskDeleted: vi.fn(),
  },
}));

vi.mock('../../../shared/jobs/index.js', () => ({
  getXpProcessingQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    getOrSet: vi.fn((_k: string, fn: () => Promise<unknown>) => fn()),
    invalidateUserStreak: vi.fn().mockResolvedValue(undefined),
    invalidateDashboard: vi.fn().mockResolvedValue(undefined),
  },
  CACHE_KEYS: {
    dashboard: (u: string) => `cache:dashboard:${u}`,
  },
}));

vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: {
    updateFromEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Issue #142 — Parity, Concurrency, and Bounded Document Bloat', () => {
  let userId: string;

  beforeAll(async () => {
    await Promise.all([
      User.init(),
      UserStreakLog.init(),
      UserAnalytics.init(),
      DailyActivity.init(),
    ]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    userId = new Types.ObjectId().toHexString();
    await User.create({
      _id: userId,
      clerkId: `clerk_${userId}`,
      username: `user_${userId}`,
      email: `${userId}@example.test`,
      displayName: 'Parity User',
      timezone: 'UTC',
    });
  });

  describe('1. Dashboard and Streak parity across timezones', () => {
    const timezones = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Europe/London'];

    it.each(timezones)(
      'returns identical currentStreak and longestStreak for %s',
      async (tz) => {
        await User.findByIdAndUpdate(userId, { timezone: tz });

        // Record 3 days of consecutive activity in this timezone
        const base = new Date('2026-10-21T10:00:00Z');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(base);

        for (let i = 2; i >= 0; i--) {
          const actDate = new Date(base.getTime() - i * 86_400_000);
          await recordActivity({
            userId,
            streakType: 'dsa',
            source: `sub-${i}`,
            activityDate: actDate,
            timezone: tz,
          });
        }

        const streakStatus = await getStreakStatus(userId);
        const streakData = await getStreakData(userId);
        const dashboardStats = await getDashboardStats(userId);

        expect(streakData.currentStreak).toBe(streakStatus.currentStreak);
        expect(streakData.longestStreak).toBe(streakStatus.bestStreak);
        expect(dashboardStats.currentStreak).toBe(streakStatus.currentStreak);
        expect(dashboardStats.longestStreak).toBe(streakStatus.bestStreak);
        expect(streakStatus.currentStreak).toBe(3);
        expect(streakStatus.bestStreak).toBe(3);

        vi.useRealTimers();
      }
    );

    it('returns identical streaks when falling back to DailyActivity', async () => {
      const today = new Date('2026-10-21T12:00:00Z');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(today);

      // Seed only DailyActivity, no UserStreakLog
      await DailyActivity.insertMany([
        { userId, date: new Date('2026-10-21T00:00:00Z'), count: 2 },
        { userId, date: new Date('2026-10-20T00:00:00Z'), count: 1 },
      ]);

      const streakStatus = await getStreakStatus(userId);
      const streakData = await getStreakData(userId);
      const dashboardStats = await getDashboardStats(userId);

      expect(streakData.currentStreak).toBe(streakStatus.currentStreak);
      expect(streakData.longestStreak).toBe(streakStatus.bestStreak);
      expect(dashboardStats.currentStreak).toBe(streakStatus.currentStreak);
      expect(dashboardStats.longestStreak).toBe(streakStatus.bestStreak);
      expect(streakStatus.currentStreak).toBe(2);

      vi.useRealTimers();
    });
  });

  describe('2. Concurrent UserStreakLog upserts', () => {
    it('produces exactly one document with accurate count and zero duplicate-key crashes under 10 concurrent writes', async () => {
      const targetDate = new Date('2026-10-21T12:00:00Z');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(targetDate);

      // Fire 10 concurrent requests for the exact same (userId, dateKey) with distinct sources
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          recordActivity({
            userId,
            streakType: 'dsa',
            source: `concurrent-src-${i}`,
            activityDate: targetDate,
            timezone: 'UTC',
          })
        )
      );

      // Verify zero rejected promises
      for (const res of results) {
        expect(res.status).toBe('fulfilled');
      }

      // Exactly ONE document must exist in UserStreakLog for this user and date
      const logs = await UserStreakLog.find({ userId });
      expect(logs).toHaveLength(1);
      expect(logs[0].activityCount).toBe(10);
      expect(logs[0].sources).toHaveLength(10);
      expect(logs[0].dateKey).toBe('2026-10-21');

      vi.useRealTimers();
    });

    it('deduplicates identical source under concurrent replays without duplicating count', async () => {
      const targetDate = new Date('2026-10-21T12:00:00Z');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(targetDate);

      // Fire 10 concurrent requests with the identical duplicate source
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          recordActivity({
            userId,
            streakType: 'dsa',
            source: 'identical-replay-source',
            activityDate: targetDate,
            timezone: 'UTC',
          })
        )
      );

      for (const res of results) {
        expect(res.status).toBe('fulfilled');
      }

      const logs = await UserStreakLog.find({ userId });
      expect(logs).toHaveLength(1);
      expect(logs[0].activityCount).toBe(1);
      expect(logs[0].sources).toEqual(['identical-replay-source']);

      vi.useRealTimers();
    });
  });

  describe('3. Bounded DailyActivity array size (O(1) per day)', () => {
    it('keeps activities array bounded when 50 activities of the same type are logged', async () => {
      const targetDate = new Date('2026-10-21T12:00:00Z');

      for (let i = 0; i < 50; i++) {
        await incrementDailyActivity(userId, targetDate, 'submission');
      }

      const dailyDoc = await DailyActivity.findOne({ userId });
      expect(dailyDoc).not.toBeNull();
      expect(dailyDoc!.count).toBe(50);
      // Array size is O(1): exactly 1 entry for 'submission' with count 50
      expect(dailyDoc!.activities).toHaveLength(1);
      expect(dailyDoc!.activities[0]).toMatchObject({
        type: 'submission',
        count: 50,
      });
    });

    it('aggregates multiple distinct activity types into bounded distinct array slots', async () => {
      const targetDate = new Date('2026-10-21T12:00:00Z');

      for (let i = 0; i < 30; i++) {
        await incrementDailyActivity(userId, targetDate, 'submission');
      }
      for (let i = 0; i < 20; i++) {
        await incrementDailyActivity(userId, targetDate, 'commit');
      }

      const dailyDoc = await DailyActivity.findOne({ userId });
      expect(dailyDoc!.count).toBe(50);
      // Array size is 2 (one slot per type)
      expect(dailyDoc!.activities).toHaveLength(2);

      const subType = dailyDoc!.activities.find((a) => a.type === 'submission');
      const comType = dailyDoc!.activities.find((a) => a.type === 'commit');
      expect(subType?.count).toBe(30);
      expect(comType?.count).toBe(20);
    });

    it('collapses legacy bloated duplicate array entries cleanly on new writes', async () => {
      const targetDate = new Date();
      targetDate.setHours(0, 0, 0, 0);

      // Seed a legacy document with duplicate unaggregated entries
      await DailyActivity.create({
        userId,
        date: targetDate,
        count: 3,
        activities: [
          { type: 'submission', count: 1 },
          { type: 'submission', count: 1 },
          { type: 'submission', count: 1 },
        ],
      });

      // Write one more activity
      await incrementDailyActivity(userId, targetDate, 'submission');

      const dailyDoc = await DailyActivity.findOne({ userId, date: targetDate });
      expect(dailyDoc).not.toBeNull();
      expect(dailyDoc!.count).toBe(4);
      // Cleanly collapsed into a single consolidated element
      expect(dailyDoc!.activities).toHaveLength(1);
      expect(dailyDoc!.activities[0]).toMatchObject({
        type: 'submission',
        count: 4,
      });
    });
  });
});
