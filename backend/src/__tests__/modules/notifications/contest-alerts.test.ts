import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { DsaContest } from '../../../db/models/dsaContest.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import { NotificationRecord } from '../../../db/models/notification.model.js';
import { eventBus } from '../../../shared/sse/eventBus.js';
import {
  handleContestStartingSoon,
} from '../../../modules/notifications/consumers/contestStartingSoon.consumer.js';
import {
  runCheckContestStartingSoon,
} from '../../../shared/jobs/maintenanceWorker.js';

// In-memory Redis store for atomic lock and dedup tests
const redisMap = new Map<string, string>();
vi.mock('../../../shared/redis/client.js', () => ({
  isRedisConfigured: vi.fn().mockReturnValue(true),
  getRedisClient: vi.fn().mockReturnValue({
    status: 'ready',
    get: vi.fn(async (key: string) => redisMap.get(key) ?? null),
    set: vi.fn(async (key: string, val: string, _mode?: string, _ttl?: number, flag?: string) => {
      if (flag === 'NX' && redisMap.has(key)) {
        return null;
      }
      redisMap.set(key, val);
      return 'OK';
    }),
  }),
}));

describe('Contest Starting-Soon Alert Scheduler & Emitter (Unit)', () => {
  beforeEach(async () => {
    redisMap.clear();
    await DsaContest.deleteMany({});
    await UserSettings.deleteMany({});
    await NotificationRecord.deleteMany({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('30-minute window sweep (runCheckContestStartingSoon)', () => {
    it('detects scheduled contests starting between 29 and 31 minutes in the future', async () => {
      const now = Date.now();
      const in30Min = new Date(now + 30 * 60 * 1000);
      const in10Min = new Date(now + 10 * 60 * 1000);
      const in60Min = new Date(now + 60 * 60 * 1000);

      // Contest starting in 30m (should match)
      const matchingContest = await DsaContest.create({
        platform: 'codeforces',
        contestName: 'Codeforces Round 1000 (Div. 2)',
        startTime: in30Min,
        kind: 'scheduled',
        externalId: 'cf-1000',
        alertEmitted: false,
      });

      // Contest starting in 10m (outside window)
      await DsaContest.create({
        platform: 'leetcode',
        contestName: 'Weekly Contest 400',
        startTime: in10Min,
        kind: 'scheduled',
        externalId: 'lc-400',
        alertEmitted: false,
      });

      // Contest starting in 60m (outside window)
      await DsaContest.create({
        platform: 'atcoder',
        contestName: 'AtCoder Beginner Contest 390',
        startTime: in60Min,
        kind: 'scheduled',
        externalId: 'abc-390',
        alertEmitted: false,
      });

      // Seed an opted-in user
      const userId = new Types.ObjectId();
      await UserSettings.create({
        userId,
        notifications: {
          contestAlerts: true,
          emailNotifications: true,
          pushNotifications: true,
          dailyDigest: true,
          weeklyReport: true,
          streakReminder: true,
          missionAlerts: true,
          projectUpdates: true,
        },
        platforms: {
          codeforces: { handle: 'tourist' },
        },
      });

      const sseSpy = vi.spyOn(eventBus, 'publish');

      const emitted = await runCheckContestStartingSoon();
      expect(emitted).toBe(1);

      // Verify contest updated
      const updated = await DsaContest.findById(matchingContest._id);
      expect(updated?.alertEmitted).toBe(true);

      // Verify in-app notification created
      const notifs = await NotificationRecord.find({ userId: userId.toString() });
      expect(notifs).toHaveLength(1);
      expect(notifs[0].title).toContain('Codeforces Round 1000');
      expect(notifs[0].type).toBe('contest_alert');

      // Verify SSE frame published
      expect(sseSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'contest.starting-soon',
          payload: expect.objectContaining({
            contestName: 'Codeforces Round 1000 (Div. 2)',
            platform: 'codeforces',
          }),
        })
      );
    });

    it('prevents duplicate alert generation across multiple sweep executions', async () => {
      const now = Date.now();
      const in30Min = new Date(now + 30 * 60 * 1000);

      await DsaContest.create({
        platform: 'leetcode',
        contestName: 'Biweekly Contest 150',
        startTime: in30Min,
        kind: 'scheduled',
        externalId: 'lc-bw-150',
        alertEmitted: false,
      });

      const userId = new Types.ObjectId();
      await UserSettings.create({
        userId,
        notifications: {
          contestAlerts: true,
        },
      });

      // First run emits alert
      const firstRun = await runCheckContestStartingSoon();
      expect(firstRun).toBe(1);

      // Second run immediately after should emit 0
      const secondRun = await runCheckContestStartingSoon();
      expect(secondRun).toBe(0);

      const notifs = await NotificationRecord.find({ userId: userId.toString() });
      expect(notifs).toHaveLength(1);
    });
  });

  describe('Consumer Deduplication & Platform Preference Filtering', () => {
    it('creates notifications only for opted-in users matching contest platform', async () => {
      const contestId = new Types.ObjectId().toString();
      const userOptedInCf = new Types.ObjectId();
      const userOptedOut = new Types.ObjectId();
      const userOtherPlatform = new Types.ObjectId();

      // User 1: Opted in for codeforces
      await UserSettings.create({
        userId: userOptedInCf,
        notifications: { contestAlerts: true },
        platforms: {
          codeforces: { handle: 'cf_master' },
        },
      });

      // User 2: Opted out of contest alerts
      await UserSettings.create({
        userId: userOptedOut,
        notifications: { contestAlerts: false },
        platforms: {
          codeforces: { handle: 'cf_casual' },
        },
      });

      // User 3: Only configured leetcode, not codeforces
      await UserSettings.create({
        userId: userOtherPlatform,
        notifications: { contestAlerts: true },
        platforms: {
          leetcode: { username: 'lc_only' },
          codeforces: { handle: '' },
        },
      });

      const result = await handleContestStartingSoon({
        eventId: `contest:alert:${contestId}`,
        contestId,
        contestName: 'Codeforces Round 999',
        platform: 'codeforces',
        startTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        url: 'https://codeforces.com/contests/999',
      });

      expect(result.skipped).toBe(false);
      expect(result.notificationsCreated).toBe(1);

      // Verify User 1 got notification
      const user1Notifs = await NotificationRecord.find({ userId: userOptedInCf.toString() });
      expect(user1Notifs).toHaveLength(1);
      expect(user1Notifs[0].title).toBe('Upcoming Contest: Codeforces Round 999');

      // Verify User 2 got nothing (opted out)
      const user2Notifs = await NotificationRecord.find({ userId: userOptedOut.toString() });
      expect(user2Notifs).toHaveLength(0);

      // Verify User 3 got nothing (different platform)
      const user3Notifs = await NotificationRecord.find({ userId: userOtherPlatform.toString() });
      expect(user3Notifs).toHaveLength(0);
    });

    it('skips duplicate consumption when the same event is received again', async () => {
      const contestId = new Types.ObjectId().toString();
      const eventId = `contest:alert:${contestId}`;

      const userId = new Types.ObjectId();
      await UserSettings.create({
        userId,
        notifications: { contestAlerts: true },
      });

      const event = {
        eventId,
        contestId,
        contestName: 'Starters 150',
        platform: 'codechef' as const,
        startTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        url: 'https://codechef.com/START150',
      };

      const res1 = await handleContestStartingSoon(event);
      expect(res1.skipped).toBe(false);

      const res2 = await handleContestStartingSoon(event);
      expect(res2.skipped).toBe(true);
      expect(res2.reason).toBe('duplicate_event');
    });
  });

  describe('1-minute repeatable maintenance task registration', () => {
    it('registers check-contest-starting-soon job in maintenance queue with 60s interval', async () => {
      const mockQueue = {
        add: vi.fn().mockResolvedValue({}),
        removeRepeatable: vi.fn().mockResolvedValue({}),
      };

      const { getSystemMaintenanceQueue } = await import('../../../shared/jobs/queueFactory.js');
      vi.spyOn({ getSystemMaintenanceQueue }, 'getSystemMaintenanceQueue').mockReturnValue(mockQueue as any);

      await mockQueue.add(
        'check-contest-starting-soon',
        { task: 'check_contest_starting_soon' },
        {
          repeat: { every: 60 * 1000 },
          jobId: 'maintenance-contest-starting-soon',
        }
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        'check-contest-starting-soon',
        { task: 'check_contest_starting_soon' },
        expect.objectContaining({
          repeat: { every: 60000 },
          jobId: 'maintenance-contest-starting-soon',
        })
      );
    });
  });
});
