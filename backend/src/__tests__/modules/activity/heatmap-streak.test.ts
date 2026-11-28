import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { DailyActivity } from '../../../db/models/index.js';
import { getHeatmap } from '../../../modules/activity/activity.service.js';
import { getStartOfDay, subtractDays } from '../../../shared/date.js';

describe('Heatmap streaks across the year boundary', () => {
  afterEach(async () => {
    vi.useRealTimers();
    await DailyActivity.deleteMany({});
  });

  async function seedRun(userId: string, days: number) {
    const today = getStartOfDay();
    await DailyActivity.insertMany(
      Array.from({ length: days }, (_, i) => ({ userId, date: subtractDays(today, i), count: 1 })),
    );
  }

  it('counts the current streak from before 1 January', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const userId = new Types.ObjectId().toHexString();
    await seedRun(userId, 17);

    const { summary, days } = await getHeatmap(userId, 2026);

    expect(summary.currentStreak).toBe(17);
    expect(summary.totalActiveDays).toBeLessThan(17);
    expect(summary.longestStreak).toBe(summary.totalActiveDays);
    expect(days.every((d) => d.date <= '2026-12-31')).toBe(true);
  });

  it('reports the same current streak when a past year is requested', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    const userId = new Types.ObjectId().toHexString();
    await seedRun(userId, 17);

    const { summary } = await getHeatmap(userId, 2025);

    expect(summary.currentStreak).toBe(17);
  });
});
