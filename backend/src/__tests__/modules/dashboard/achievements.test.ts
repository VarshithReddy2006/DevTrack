import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { DailyActivity, UserAnalytics } from '../../../db/models/index.js';
import { getAchievements, getDashboardStats } from '../../../modules/dashboard/dashboard.service.js';

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    getOrSet: vi.fn((_key: string, fn: () => Promise<unknown>) => fn()),
  },
  CACHE_KEYS: {
    dashboard: (userId: string) => `cache:dashboard:${userId}`,
  },
}));

const DAY = 86_400_000;

describe('getAchievements', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await DailyActivity.deleteMany({});
    await UserAnalytics.deleteMany({});
  });

  it('keeps streak badges unlocked after the streak breaks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-30T12:00:00Z'));
    const userId = new Types.ObjectId().toHexString();
    // 30 consecutive active days that ended three weeks ago
    const start = Date.parse('2026-05-10T00:00:00Z');
    await DailyActivity.insertMany(
      Array.from({ length: 30 }, (_, i) => ({ userId, date: new Date(start + i * DAY), count: 1 })),
    );

    // The best streak was stored while the run was still active
    await UserAnalytics.create({ userId, currentStreak: 30, bestStreak: 30 });

    const stats = await getDashboardStats(userId);
    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(30);

    const { achievements, totalXp } = await getAchievements(userId);
    const streakBadges = achievements.filter((a) => a.category === 'streak');
    expect(streakBadges.length).toBeGreaterThan(0);
    for (const badge of streakBadges) {
      expect(badge.isUnlocked).toBe(badge.target <= 30);
      expect(badge.progress).toBe(Math.min(30, badge.target));
    }
    expect(totalXp).toBeGreaterThan(0);
  });

  it('does not report the request time as the unlock time', async () => {
    const userId = new Types.ObjectId().toHexString();
    await DailyActivity.create({ userId, date: new Date(), count: 1 });
    await UserAnalytics.create({ userId, currentStreak: 30, bestStreak: 30 });

    const { achievements, totalUnlocked } = await getAchievements(userId);

    expect(totalUnlocked).toBeGreaterThan(0);
    expect(achievements.every((a) => a.unlockedAt === null)).toBe(true);
  });
});
