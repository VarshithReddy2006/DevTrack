import { afterEach, describe, it, expect, vi } from 'vitest';
import { Types } from 'mongoose';
import { parseLeetCodeCalendar, calculateStreaksFromHeatmap, generateRollingHeatmap, getHeatmap } from './dsa.service.js';
import { DsaProblem, DsaSubmission, PlatformStats, User } from '../../db/models/index.js';

describe('DSA Rolling Logic', () => {
  describe('parseLeetCodeCalendar', () => {
    it('should correctly parse a valid LeetCode calendar object', () => {
      const rawData = {
        submissionCalendar: {
          "2024-05-10": 5,
          "2024-05-11": 2,
          "2024-05-12": 0,
        }
      };
      const result = parseLeetCodeCalendar(rawData);
      expect(result["2024-05-10"]).toBe(5);
      expect(result["2024-05-11"]).toBe(2);
      expect(result["2024-05-12"]).toBeUndefined(); // Should skip 0
    });

    it('should parse the legacy LeetCode submissionCalendar JSON string', () => {
      // LeetCode returns a JSON string keyed by unix timestamp (seconds)
      const legacy = {
        matchedUser: {
          submissionCalendar: JSON.stringify({
            // 2024-05-10T00:00:00.000Z
            [String(Date.UTC(2024, 4, 10) / 1000)]: 3,
            // 2024-05-11T00:00:00.000Z
            [String(Date.UTC(2024, 4, 11) / 1000)]: 1,
            // 0-counts should be ignored
            [String(Date.UTC(2024, 4, 12) / 1000)]: 0,
          }),
        },
      };

      const result = parseLeetCodeCalendar(legacy as any);
      expect(result['2024-05-10']).toBe(3);
      expect(result['2024-05-11']).toBe(1);
      expect(result['2024-05-12']).toBeUndefined();
    });

    it('should parse unix-second-keyed submissionCalendar objects', () => {
      const ts = String(Date.UTC(2024, 4, 10) / 1000);
      const rawData = {
        submissionCalendar: {
          [ts]: 4,
        },
      };

      const result = parseLeetCodeCalendar(rawData as any);
      expect(result['2024-05-10']).toBe(4);
    });

    it('should return empty object for invalid calendar', () => {
      expect(parseLeetCodeCalendar({})).toEqual({});
      expect(parseLeetCodeCalendar({ submissionCalendar: "invalid" } as any)).toEqual({});
      expect(parseLeetCodeCalendar({ submissionCalendar: [] } as any)).toEqual({});
    });
  });

  describe('calculateStreaksFromHeatmap', () => {
    it('should calculate current and longest streaks correctly', () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const heatmap = [
        { date: '2024-01-01', count: 1 },
        { date: '2024-01-02', count: 1 },
        { date: '2024-01-03', count: 0 },
        { date: '2024-01-04', count: 1 },
        { date: '2024-01-05', count: 1 },
        { date: '2024-01-06', count: 1 },
        { date: '2024-01-07', count: 0 },
        // Current streak part
        { date: yesterdayStr, count: 2 },
        { date: today, count: 1 },
      ];

      const streaks = calculateStreaksFromHeatmap(heatmap);
      expect(streaks.longest).toBe(3); // Jan 4, 5, 6
      expect(streaks.current).toBe(2); // Yesterday + Today
    });

    it('should handle zero streaks', () => {
      const heatmap = [
        { date: '2024-01-01', count: 0 },
        { date: '2024-01-02', count: 0 },
      ];
      const streaks = calculateStreaksFromHeatmap(heatmap);
      expect(streaks.longest).toBe(0);
      expect(streaks.current).toBe(0);
    });

    it('should maintain current streak if active yesterday but not today (yet)', () => {
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const heatmap = [
        { date: yesterdayStr, count: 1 },
        { date: today, count: 0 },
      ];
      const streaks = calculateStreaksFromHeatmap(heatmap);
      expect(streaks.current).toBe(1);
    });
  });

  describe('generateRollingHeatmap', () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('produces exactly 365 contiguous unique UTC days ending on today UTC without timezone drift', async () => {
      const todayUtc = new Date().toISOString().split('T')[0];
      vi.spyOn(DsaSubmission, 'aggregate').mockResolvedValueOnce([
        { _id: todayUtc, count: 5 },
      ] as any);
      vi.spyOn(PlatformStats, 'findOne').mockReturnValue({
        select: () => ({
          lean: () => Promise.resolve({ rawData: { submissionCalendar: { [todayUtc]: 2 } } }),
        }),
      } as any);

      const userId = '507f1f77bcf86cd799439011';
      const heatmap = await generateRollingHeatmap(userId);

      expect(heatmap).toHaveLength(365);
      expect(heatmap[heatmap.length - 1].date).toBe(todayUtc);
      expect(heatmap[heatmap.length - 1].count).toBe(7); // 5 CF + 2 LC

      // Verify all dates are unique and strictly formatted YYYY-MM-DD
      const dates = heatmap.map((h) => h.date);
      const uniqueDates = new Set(dates);
      expect(uniqueDates.size).toBe(365);
      for (const d of dates) {
        expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }

      // Verify contiguous progression: each consecutive date is exactly +1 day in UTC
      for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1] + 'T00:00:00.000Z');
        const curr = new Date(dates[i] + 'T00:00:00.000Z');
        const diffMs = curr.getTime() - prev.getTime();
        expect(diffMs).toBe(24 * 60 * 60 * 1000);
      }
    });

    it('buckets submissions across midnight boundaries in Asia/Kolkata, UTC, and America/Chicago (UTC-5)', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-05-01T21:00:00.000Z') });

      const user = await User.create({
        clerkId: 'clerk_tz_1',
        email: 'tz1@example.com',
        username: 'tzuser1',
        displayName: 'TZ User',
        timezone: 'Asia/Kolkata',
      });
      const problem = await DsaProblem.create({
        userId: user._id,
        externalId: '4-A',
        title: 'Watermelon',
        platform: 'codeforces',
        difficulty: 'easy',
        url: 'https://codeforces.com/problemset/problem/4/A',
        category: 'Math',
        status: 'solved',
      });

      // 2026-05-01T21:00:00Z == 2026-05-02T02:30:00+05:30 (Asia/Kolkata) == 2026-05-01T16:00:00-05:00 (America/Chicago)
      // 2026-05-02T03:00:00Z == 2026-05-01T22:00:00-05:00 (America/Chicago, CDT UTC-5)
      await DsaSubmission.create([
        {
          userId: user._id,
          problemId: problem._id,
          externalId: 'cf-late-ist',
          platform: 'codeforces',
          status: 'accepted',
          submittedAt: new Date('2026-05-01T21:00:00.000Z'),
          language: 'cpp',
        },
        {
          userId: user._id,
          problemId: problem._id,
          externalId: 'cf-late-chi',
          platform: 'codeforces',
          status: 'accepted',
          submittedAt: new Date('2026-05-02T03:00:00.000Z'),
          language: 'cpp',
        },
      ]);

      // Uses User.timezone ('Asia/Kolkata') automatically when timeZone param is omitted
      const istHeatmap = await generateRollingHeatmap(user._id.toString());
      expect(istHeatmap).toHaveLength(365);
      expect(istHeatmap[istHeatmap.length - 1]).toEqual({ date: '2026-05-02', count: 2 });

      // Explicit UTC only sees 2026-05-01T21:00:00Z inside the window ending 2026-05-01 UTC
      const utcHeatmap = await generateRollingHeatmap(user._id.toString(), 'UTC');
      expect(utcHeatmap).toHaveLength(365);
      expect(utcHeatmap[utcHeatmap.length - 1]).toEqual({ date: '2026-05-01', count: 1 });

      // At 2026-05-02T03:30:00Z (2026-05-01T22:30:00-05:00 in America/Chicago), both submissions belong to 2026-05-01
      vi.setSystemTime(new Date('2026-05-02T03:30:00.000Z'));
      const chiHeatmap = await generateRollingHeatmap(user._id.toString(), 'America/Chicago');
      expect(chiHeatmap).toHaveLength(365);
      expect(chiHeatmap[chiHeatmap.length - 1]).toEqual({ date: '2026-05-01', count: 2 });

      // getHeatmap also aligns currentStreak with the user's timezone
      vi.setSystemTime(new Date('2026-05-01T21:00:00.000Z'));
      const istSummary = await getHeatmap(user._id.toString());
      expect(istSummary.currentStreak).toBe(1);
    });

    it('falls back safely to UTC when user or explicit timezone is invalid or missing', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-05-01T21:00:00.000Z') });

      const user = await User.create({
        clerkId: 'clerk_tz_invalid',
        email: 'tzinvalid@example.com',
        username: 'tzinvalid',
        displayName: 'TZ Invalid',
        timezone: 'Mars/Olympus_Mons',
      });
      const problem = await DsaProblem.create({
        userId: user._id,
        externalId: '71-A',
        title: 'Way Too Long Words',
        platform: 'codeforces',
        difficulty: 'easy',
        url: 'https://codeforces.com/problemset/problem/71/A',
        category: 'Strings',
        status: 'solved',
      });
      await DsaSubmission.create({
        userId: user._id,
        problemId: problem._id,
        externalId: 'cf-fallback-1',
        platform: 'codeforces',
        status: 'accepted',
        submittedAt: new Date('2026-05-01T21:00:00.000Z'),
        language: 'cpp',
      });

      const fromUserInvalid = await generateRollingHeatmap(user._id.toString());
      expect(fromUserInvalid).toHaveLength(365);
      expect(fromUserInvalid[fromUserInvalid.length - 1]).toEqual({ date: '2026-05-01', count: 1 });

      const fromArgInvalid = await generateRollingHeatmap(user._id.toString(), 'Not/A_Timezone');
      expect(fromArgInvalid).toHaveLength(365);
      expect(fromArgInvalid[fromArgInvalid.length - 1]).toEqual({ date: '2026-05-01', count: 1 });

      const missingUserHeatmap = await generateRollingHeatmap(new Types.ObjectId().toString());
      expect(missingUserHeatmap).toHaveLength(365);
      expect(missingUserHeatmap[missingUserHeatmap.length - 1].date).toBe('2026-05-01');
    });
  });
});
