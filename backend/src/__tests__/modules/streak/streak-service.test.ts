// src/__tests__/modules/streak/streak-service.test.ts
// Unit tests for the streak service — activity recording, recalculation,
// deduplication, anti-cheat, and freeze mechanics.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';
import { recordActivity, recalculateStreak, activateStreakFreeze, getStreakHistory, getStreakStatus } from '../../../modules/streak/streak.service.js';
import { UserStreakLog, UserAnalytics, User, DailyActivity, type StreakType } from '../../../db/models/index.js';
import { getStreakData } from '../../../modules/dashboard/dashboard.service.js';
import { getXpProcessingQueue } from '../../../shared/jobs/index.js';
import { eventBus } from '../../../shared/sse/index.js';

// Mock non-DB dependencies
vi.mock('../../../shared/sse/index.js', () => ({
  eventBus: {
    emitStreakMilestone: vi.fn(),
    emitStreakAtRisk: vi.fn(),
  },
}));

vi.mock('../../../shared/jobs/index.js', () => ({
  getXpProcessingQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock('../../../shared/cache/cacheManager.js', () => ({
  cacheManager: {
    invalidateUserStreak: vi.fn().mockResolvedValue(undefined),
    invalidateDashboard: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: {
    updateFromEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('Streak Service — recordActivity', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
    // Create a user doc so getUserTimezone can find it
    await User.create({ _id: new Types.ObjectId(userId), username: 'testuser', email: 'test@example.com', displayName: 'Test User', clerkId: `clerk_${userId}` });
  });

  it('should record a new activity and create a streak log', async () => {
    await recordActivity({
      userId,
      streakType: 'dsa',
      source: 'problem-123',
      activityDate: new Date(),
      timezone: 'UTC',
    });

    const logs = await UserStreakLog.find({ userId: new Types.ObjectId(userId) });
    expect(logs.length).toBe(1);
    expect(logs[0].sources).toContain('problem-123');
    expect(logs[0].activityCount).toBe(1);
    expect(logs[0].streakType).toBe('dsa');
  });

  it('should deduplicate same source on same day', async () => {
    const today = new Date();

    await recordActivity({
      userId,
      streakType: 'dsa',
      source: 'dup-source',
      activityDate: today,
      timezone: 'UTC',
    });

    await recordActivity({
      userId,
      streakType: 'dsa',
      source: 'dup-source',
      activityDate: today,
      timezone: 'UTC',
    });

    const logs = await UserStreakLog.find({ userId: new Types.ObjectId(userId) });
    expect(logs.length).toBe(1);
    expect(logs[0].activityCount).toBe(1); // Not incremented for duplicate source
  });

  it('should add multiple sources to same day', async () => {
    const today = new Date();

    await recordActivity({
      userId,
      streakType: 'dsa',
      source: 'source-a',
      activityDate: today,
      timezone: 'UTC',
    });

    await recordActivity({
      userId,
      streakType: 'dsa',
      source: 'source-b',
      activityDate: today,
      timezone: 'UTC',
    });

    const logs = await UserStreakLog.find({ userId: new Types.ObjectId(userId) });
    expect(logs.length).toBe(1);
    expect(logs[0].activityCount).toBe(2);
    expect(logs[0].sources).toContain('source-a');
    expect(logs[0].sources).toContain('source-b');
  });

  it('should reject activities older than 2 days (anti-cheat)', async () => {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    await recordActivity({
      userId,
      streakType: 'dsa',
      source: 'old-activity',
      activityDate: threeDaysAgo,
      timezone: 'UTC',
    });

    const logs = await UserStreakLog.find({ userId: new Types.ObjectId(userId) });
    expect(logs.length).toBe(0); // Rejected
  });

  it('should accept activities within 2-day window', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    await recordActivity({
      userId,
      streakType: 'dsa',
      source: 'yesterday-activity',
      activityDate: yesterday,
      timezone: 'UTC',
    });

    const logs = await UserStreakLog.find({ userId: new Types.ObjectId(userId) });
    expect(logs.length).toBe(1);
  });
});

describe('Streak Service — recalculateStreak', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
    await User.create({ _id: new Types.ObjectId(userId), username: 'testuser2', email: 'test2@example.com', displayName: 'Test User 2', clerkId: `clerk_${userId}` });
  });

  it('should return 0 streak when no logs exist', async () => {
    const status = await recalculateStreak(userId, 'dsa');

    expect(status.currentStreak).toBe(0);
    expect(status.isActiveToday).toBe(false);
    expect(status.lastActiveDate).toBeNull();
  });

  it('should calculate streak of 1 for a single day activity', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    await UserStreakLog.create({
      userId: new Types.ObjectId(userId),
      date: today,
      streakType: 'dsa',
      activityCount: 1,
      sources: ['source-1'],
      timezone: 'UTC',
    });

    const status = await recalculateStreak(userId, 'dsa');
    expect(status.currentStreak).toBe(1);
    expect(status.isActiveToday).toBe(true);
  });

  it('should calculate consecutive day streaks correctly', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    await UserStreakLog.insertMany([
      { userId: new Types.ObjectId(userId), date: today, streakType: 'dsa', activityCount: 1, sources: ['s1'], timezone: 'UTC' },
      { userId: new Types.ObjectId(userId), date: yesterday, streakType: 'dsa', activityCount: 1, sources: ['s2'], timezone: 'UTC' },
      { userId: new Types.ObjectId(userId), date: twoDaysAgo, streakType: 'dsa', activityCount: 1, sources: ['s3'], timezone: 'UTC' },
    ]);

    const status = await recalculateStreak(userId, 'dsa');
    expect(status.currentStreak).toBe(3);
    expect(status.isActiveToday).toBe(true);
  });

  it('should break streak on a gap day', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Active today and 3 days ago but not yesterday
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    await UserStreakLog.insertMany([
      { userId: new Types.ObjectId(userId), date: today, streakType: 'dsa', activityCount: 1, sources: ['s1'], timezone: 'UTC' },
      { userId: new Types.ObjectId(userId), date: threeDaysAgo, streakType: 'dsa', activityCount: 1, sources: ['s2'], timezone: 'UTC' },
    ]);

    const status = await recalculateStreak(userId, 'dsa');
    expect(status.currentStreak).toBe(1); // Only today counts
  });

  it('should update bestStreak when current exceeds it', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Set an existing bestStreak of 1
    await UserAnalytics.create({
      userId: new Types.ObjectId(userId),
      bestStreak: 1,
      currentStreak: 1,
    });

    await UserStreakLog.insertMany([
      { userId: new Types.ObjectId(userId), date: today, streakType: 'dsa', activityCount: 1, sources: ['s1'], timezone: 'UTC' },
      { userId: new Types.ObjectId(userId), date: yesterday, streakType: 'dsa', activityCount: 1, sources: ['s2'], timezone: 'UTC' },
    ]);

    const status = await recalculateStreak(userId, 'dsa');
    expect(status.currentStreak).toBe(2);
    expect(status.bestStreak).toBe(2);
  });
});

describe('Streak Service — calendar continuity regressions', () => {
  let userId: string;
  const validFreeze = new Date('2026-10-22T12:00:00Z');

  beforeAll(async () => {
    await Promise.all([User.init(), UserStreakLog.init(), UserAnalytics.init(), DailyActivity.init()]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Keep MongoDB's network and timeout timers real.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    userId = new Types.ObjectId().toHexString();
    await User.create({ _id: userId, username: `u${userId}`, email: `${userId}@example.test`,
      displayName: 'Streak Regression', clerkId: `clerk_${userId}`, timezone: 'UTC' });
  });

  afterEach(() => { vi.useRealTimers(); });

  async function seedDays(dates: string[], streakType: StreakType = 'dsa', owner = userId) {
    await UserStreakLog.insertMany(dates.map(date => ({
      userId: owner, date: new Date(`${date}T00:00:00Z`), streakType,
      activityCount: 1, sources: [`source-${date}`], timezone: 'UTC',
    })));
  }

  it.each([
    { timezone: 'UTC', now: '2026-10-21T00:15:00Z', older: '2026-10-19T00:05:00Z', latest: '2026-10-21T00:05:00Z', day: '2026-10-21' },
    { timezone: 'Asia/Kolkata', now: '2026-10-21T19:15:00Z', older: '2026-10-19T19:00:00Z', latest: '2026-10-21T19:00:00Z', day: '2026-10-22' },
    { timezone: 'America/Los_Angeles', now: '2026-10-21T07:15:00Z', older: '2026-10-19T07:05:00Z', latest: '2026-10-21T07:05:00Z', day: '2026-10-21' },
  ])('breaks an unprotected gap near midnight in $timezone', async (spec) => {
    vi.setSystemTime(new Date(spec.now));
    await User.findByIdAndUpdate(userId, { timezone: spec.timezone });
    await recordActivity({ userId, streakType: 'dsa', source: 'older', timezone: spec.timezone, activityDate: new Date(spec.older) });
    const latest = { userId, streakType: 'dsa' as const, source: 'latest', timezone: spec.timezone, activityDate: new Date(spec.latest) };
    await recordActivity(latest);
    await recordActivity(latest);
    const status = await getStreakStatus(userId, 'dsa');
    const analytics = await UserAnalytics.findOne({ userId }).lean();
    const logs = await UserStreakLog.find({ userId }).sort({ date: 1 }).lean();

    expect(logs.map(log => log.activityCount)).toEqual([1, 1]);
    expect(logs[1].date).toEqual(new Date(`${spec.day}T00:00:00Z`));
    expect.soft(status).toEqual({ currentStreak: 1, bestStreak: 1, streakType: 'dsa',
      lastActiveDate: new Date(`${spec.day}T00:00:00Z`), isActiveToday: true, streakFreezeUntil: null });
    expect(analytics).toMatchObject({ currentStreak: 1, bestStreak: 1, currentStreakType: 'dsa' });
  });

  it('retains yesterday grace without allowing another historical gap', async () => {
    await seedDays(['2026-10-20', '2026-10-18']);
    const status = await getStreakStatus(userId, 'dsa');
    expect(status.currentStreak).toBe(1);
    expect(status.isActiveToday).toBe(false);
    expect(status.lastActiveDate).toEqual(new Date('2026-10-20T00:00:00Z'));
  });

  it('retains yesterday-only grace', async () => {
    await seedDays(['2026-10-20']);
    expect(await getStreakStatus(userId, 'dsa')).toMatchObject({ currentStreak: 1, isActiveToday: false });
  });

  it.each([
    { name: 'valid one-day protection', days: ['21', '19'], freeze: validFreeze, expected: 2, remaining: null },
    { name: 'expired earlier today', days: ['21', '19'], freeze: new Date('2026-10-21T11:00:00Z'), expected: 1, remaining: null },
    { name: 'expired yesterday', days: ['21', '19'], freeze: new Date('2026-10-20T23:00:00Z'), expected: 1, remaining: null },
    { name: 'already consumed protection', days: ['21', '19'], freeze: null, expected: 1, remaining: null },
    { name: 'two missed days', days: ['21', '18'], freeze: validFreeze, expected: 1, remaining: validFreeze },
    { name: 'two separate missing days', days: ['21', '19', '17'], freeze: validFreeze, expected: 2, remaining: null },
    { name: 'unnecessary protection on consecutive days', days: ['21', '20', '19'], freeze: validFreeze, expected: 3, remaining: validFreeze },
    { name: 'initial grace plus one protected day', days: ['19'], freeze: validFreeze, expected: 1, remaining: null },
    { name: 'initial gap without protection', days: ['19'], freeze: null, expected: 0, remaining: null },
    { name: 'initial gap beyond protection', days: ['18'], freeze: validFreeze, expected: 0, remaining: validFreeze },
  ])('handles $name', async ({ days, freeze, expected, remaining }) => {
    await seedDays(days.map(day => `2026-10-${day}`));
    await UserAnalytics.create({ userId, streakFreezeUntil: freeze });
    const status = await recalculateStreak(userId, 'dsa');
    const analytics = await UserAnalytics.findOne({ userId }).lean();
    expect.soft(status.currentStreak).toBe(expected);
    expect.soft(analytics).toMatchObject({ currentStreak: expected, bestStreak: expected, streakFreezeUntil: remaining });
    if (freeze === validFreeze) expect(status.streakFreezeUntil).toEqual(remaining);
  });

  it('suppresses false milestones and persists only the consecutive suffix', async () => {
    await seedDays(['2026-10-21', '2026-10-19', '2026-10-17']);
    const status = await recalculateStreak(userId, 'dsa');
    expect.soft(status.currentStreak).toBe(1);
    expect.soft(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({ currentStreak: 1, bestStreak: 1 });
    expect.soft(eventBus.emitStreakMilestone).not.toHaveBeenCalled();
    expect(getXpProcessingQueue().add).not.toHaveBeenCalled();
  });

  it('queues a genuine three-day milestone exactly once', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19']);
    expect((await recalculateStreak(userId, 'dsa')).currentStreak).toBe(3);
    await recalculateStreak(userId, 'dsa');
    expect(eventBus.emitStreakMilestone).toHaveBeenCalledExactlyOnceWith(userId, 3, 'dsa');
    expect(getXpProcessingQueue().add).toHaveBeenCalledExactlyOnceWith('streak-milestone', {
      userId, sourceType: 'daily_streak', sourceId: 'streak_3_2026-10-19',
      metadata: { streakDays: 3, streakType: 'dsa' },
    });
  });

  it('preserves historical best while correcting current streak forward', async () => {
    await seedDays(['2026-10-21', '2026-10-19']);
    await UserAnalytics.create({ userId, currentStreak: 9, bestStreak: 12 });
    expect(await recalculateStreak(userId, 'dsa')).toMatchObject({ currentStreak: 1, bestStreak: 12 });
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({ currentStreak: 1, bestStreak: 12 });
  });

  it('counts multiple sources and duplicate replays as one calendar day', async () => {
    const payload = { userId, streakType: 'dsa' as const, source: 'first', timezone: 'UTC' };
    await recordActivity(payload);
    await recordActivity(payload);
    await recordActivity({ ...payload, source: 'second' });
    const logs = await UserStreakLog.find({ userId }).lean();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ activityCount: 2, sources: ['first', 'second'] });
    expect((await getStreakStatus(userId, 'dsa')).currentStreak).toBe(1);
  });

  it.each<StreakType>(['dsa', 'github', 'focus'])('isolates ownership and %s logs', async (streakType) => {
    await seedDays(['2026-10-21', '2026-10-19'], streakType);
    await seedDays(['2026-10-20'], streakType, new Types.ObjectId().toHexString());
    await seedDays(['2026-10-20'], streakType === 'github' ? 'dsa' : 'github');
    expect(await getStreakStatus(userId, streakType)).toMatchObject({ currentStreak: 1, streakType });
  });

  it('isolates ownership for unified while counting the same user\'s other types', async () => {
    await seedDays(['2026-10-21'], 'dsa');
    await seedDays(['2026-10-20'], 'github');
    await seedDays(['2026-10-19'], 'focus');
    await seedDays(['2026-10-20', '2026-10-19', '2026-10-18'], 'dsa', new Types.ObjectId().toHexString());
    expect(await getStreakStatus(userId, 'unified')).toMatchObject({ currentStreak: 3, streakType: 'unified' });
  });

  it.each([
    { name: 'leap day', now: '2024-03-01T12:00:00Z', timezone: 'UTC', dates: ['2024-03-01', '2024-02-29', '2024-02-28'] },
    { name: 'year boundary', now: '2026-01-01T12:00:00Z', timezone: 'UTC', dates: ['2026-01-01', '2025-12-31', '2025-12-30'] },
    { name: 'spring DST', now: '2026-03-09T07:15:00Z', timezone: 'America/Los_Angeles', dates: ['2026-03-09', '2026-03-08', '2026-03-07'] },
    { name: 'autumn DST', now: '2026-11-02T08:15:00Z', timezone: 'America/Los_Angeles', dates: ['2026-11-02', '2026-11-01', '2026-10-31'] },
  ])('retains consecutive calendar days across $name', async ({ now, timezone, dates }) => {
    vi.setSystemTime(new Date(now));
    await User.findByIdAndUpdate(userId, { timezone });
    await seedDays(dates);
    expect(await getStreakStatus(userId, 'dsa')).toMatchObject({ currentStreak: 3, isActiveToday: true });
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({ currentStreak: 3, bestStreak: 3 });
  });

  it('agrees with the dashboard for equivalent activity calendars', async () => {
    await seedDays(['2026-10-21', '2026-10-19']);
    // The dashboard stores server-local dates; typed logs store user calendar labels in UTC.
    await DailyActivity.insertMany([21, 19].map(day => ({ userId, date: new Date(2026, 9, day), count: 1 })));
    const dashboard = await getStreakData(userId);
    expect(dashboard.currentStreak).toBe(1);
    expect((await getStreakStatus(userId, 'dsa')).currentStreak).toBe(dashboard.currentStreak);
  });
});

describe('Streak Service — unified recalculation and milestone ledger', () => {
  let userId: string;

  beforeAll(async () => {
    await Promise.all([User.init(), UserStreakLog.init(), UserAnalytics.init()]);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
    userId = new Types.ObjectId().toHexString();
    await User.create({ _id: userId, username: `u${userId}`, email: `${userId}@example.test`,
      displayName: 'Unified Regression', clerkId: `clerk_${userId}`, timezone: 'UTC' });
  });

  afterEach(() => { vi.useRealTimers(); });

  async function seedDays(dates: string[], streakType: StreakType) {
    await UserStreakLog.insertMany(dates.map(date => ({
      userId, date: new Date(`${date}T00:00:00Z`), streakType,
      activityCount: 1, sources: [`${streakType}-${date}`], timezone: 'UTC',
    })));
  }

  it('does not zero the shared streak when unified is recalculated', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({ currentStreak: 3 });

    const unified = await recalculateStreak(userId, 'unified');
    expect(unified).toMatchObject({ currentStreak: 3, streakType: 'unified', isActiveToday: true });
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({
      currentStreak: 3, bestStreak: 3, currentStreakType: 'unified',
      lastActiveDate: new Date('2026-10-21T00:00:00Z'),
    });
  });

  it('derives unified from the union of dsa, github and focus days', async () => {
    await seedDays(['2026-10-21'], 'dsa');
    await seedDays(['2026-10-20'], 'github');
    await seedDays(['2026-10-19'], 'focus');
    expect(await recalculateStreak(userId, 'unified')).toMatchObject({ currentStreak: 3 });
  });

  it('still resets unified when the user has no activity in any type', async () => {
    await UserAnalytics.create({ userId, currentStreak: 4, bestStreak: 6, lastActiveDate: new Date('2026-10-20T00:00:00Z') });
    expect(await recalculateStreak(userId, 'unified')).toMatchObject({ currentStreak: 0 });
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({ currentStreak: 0, bestStreak: 6, lastActiveDate: null });
  });

  it('does not zero the shared streak when a type with no logs is recalculated', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    const github = await recalculateStreak(userId, 'github');
    expect(github).toMatchObject({ currentStreak: 0, streakType: 'github', bestStreak: 3 });
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({ currentStreak: 3, currentStreakType: 'dsa' });
  });

  it('does not let a shorter typed streak lower the shared counter', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    await seedDays(['2026-10-21'], 'focus');

    // The caller still gets the focus streak, only the shared field stays put.
    const focus = await recalculateStreak(userId, 'focus');
    expect(focus).toMatchObject({ currentStreak: 1, streakType: 'focus', bestStreak: 5 });
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({
      currentStreak: 5, bestStreak: 5, currentStreakType: 'dsa',
    });
  });

  it('does not pay a milestone again after a shorter typed recalculation', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19'], 'dsa');
    await seedDays(['2026-10-21'], 'focus');
    await recalculateStreak(userId, 'dsa');
    await recalculateStreak(userId, 'focus');
    await recalculateStreak(userId, 'dsa');
    await recalculateStreak(userId, 'unified');
    expect(getXpProcessingQueue().add).toHaveBeenCalledTimes(1);
    expect(eventBus.emitStreakMilestone).toHaveBeenCalledTimes(1);
  });

  it('lets the type holding the shared counter lower it when its streak breaks', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    await seedDays(['2026-10-25'], 'dsa');
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));

    await recalculateStreak(userId, 'dsa');
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({
      currentStreak: 1, bestStreak: 3, currentStreakType: 'dsa',
      lastActiveDate: new Date('2026-10-25T00:00:00Z'),
    });
  });

  it('moves lastActiveDate forward without taking over the shared counter', async () => {
    await seedDays(['2026-10-20', '2026-10-19', '2026-10-18'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    await seedDays(['2026-10-21'], 'focus');
    await recalculateStreak(userId, 'focus');
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({
      currentStreak: 3, currentStreakType: 'dsa',
      lastActiveDate: new Date('2026-10-21T00:00:00Z'),
    });
  });

  it('does not move lastActiveDate back for a type with older activity', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    await seedDays(['2026-10-20'], 'focus');
    await recalculateStreak(userId, 'focus');
    expect(await UserAnalytics.findOne({ userId }).lean()).toMatchObject({
      currentStreak: 3, lastActiveDate: new Date('2026-10-21T00:00:00Z'),
    });
  });

  it('accepts focus as a currentStreakType', async () => {
    await seedDays(['2026-10-21'], 'focus');
    await recalculateStreak(userId, 'focus');
    const analytics = await UserAnalytics.findOne({ userId });
    expect(analytics?.currentStreakType).toBe('focus');
    expect(analytics?.validateSync()).toBeUndefined();
  });

  it('pays a milestone once when unified and dsa recalculations alternate', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    await recalculateStreak(userId, 'unified');
    await recalculateStreak(userId, 'dsa');
    await recalculateStreak(userId, 'unified');
    await recalculateStreak(userId, 'dsa');
    expect(getXpProcessingQueue().add).toHaveBeenCalledTimes(1);
    expect(eventBus.emitStreakMilestone).toHaveBeenCalledTimes(1);
  });

  it('uses the same ledger key for the same streak even if the counter is knocked back', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    // Another writer drops the shared counter (a typed recalc with a shorter streak, a manual reset).
    await UserAnalytics.updateOne({ userId }, { $set: { currentStreak: 0 } });
    vi.setSystemTime(new Date('2026-10-21T12:00:05Z'));
    await recalculateStreak(userId, 'dsa');
    await UserAnalytics.updateOne({ userId }, { $set: { currentStreak: 1 } });
    vi.setSystemTime(new Date('2026-10-21T12:00:10Z'));
    await recalculateStreak(userId, 'unified');

    const keys = vi.mocked(getXpProcessingQueue().add).mock.calls.map(call => (call[1] as { sourceId: string }).sourceId);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys)).toEqual(new Set(['streak_3_2026-10-19']));
  });

  it('keys a new streak differently once the old one has broken', async () => {
    await seedDays(['2026-10-21', '2026-10-20', '2026-10-19'], 'dsa');
    await recalculateStreak(userId, 'dsa');
    await UserStreakLog.deleteMany({ userId });
    await recalculateStreak(userId, 'unified'); // no activity left, counter goes back to 0
    await seedDays(['2026-11-03', '2026-11-02', '2026-11-01'], 'dsa');
    vi.setSystemTime(new Date('2026-11-03T12:00:00Z'));
    await recalculateStreak(userId, 'dsa');

    const keys = vi.mocked(getXpProcessingQueue().add).mock.calls.map(call => (call[1] as { sourceId: string }).sourceId);
    expect(keys).toEqual(['streak_3_2026-10-19', 'streak_3_2026-11-01']);
  });
});

describe('Streak Service — activateStreakFreeze', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
    await User.create({ _id: new Types.ObjectId(userId), username: 'testuser3', email: 'test3@example.com', displayName: 'Test User 3', clerkId: `clerk_${userId}` });
  });

  it('should set streakFreezeUntil in UserAnalytics', async () => {
    await activateStreakFreeze(userId);

    const analytics = await UserAnalytics.findOne({ userId: new Types.ObjectId(userId) });
    expect(analytics).not.toBeNull();
    expect(analytics!.streakFreezeUntil).not.toBeNull();
    // Freeze should be ~1 day from now
    const diff = analytics!.streakFreezeUntil!.getTime() - Date.now();
    expect(diff).toBeGreaterThan(0);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000); // 1 day + 1s tolerance
  });
});

describe('Streak Service — getStreakHistory', () => {
  const userId = new Types.ObjectId().toHexString();

  beforeEach(async () => {
    vi.clearAllMocks();
    await User.create({ _id: new Types.ObjectId(userId), username: 'testuser4', email: 'test4@example.com', displayName: 'Test User 4', clerkId: `clerk_${userId}` });
  });

  it('should return 30-day history with empty days filled', async () => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Create a log for today
    await UserStreakLog.create({
      userId: new Types.ObjectId(userId),
      date: today,
      streakType: 'dsa',
      activityCount: 2,
      sources: ['s1', 's2'],
      timezone: 'UTC',
    });

    const history = await getStreakHistory(userId);
    expect(history.length).toBeGreaterThanOrEqual(30);

    // Last entry should be today and active
    const todayEntry = history.find(h => h.date === today.toISOString().split('T')[0]);
    expect(todayEntry).toBeDefined();
    expect(todayEntry!.active).toBe(true);
    expect(todayEntry!.count).toBe(2);

    // Most other entries should be inactive
    const inactiveDays = history.filter(h => !h.active);
    expect(inactiveDays.length).toBeGreaterThanOrEqual(29);
  });
});
