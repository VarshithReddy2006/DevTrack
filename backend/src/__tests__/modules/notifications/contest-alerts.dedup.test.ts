import { beforeEach, describe, expect, it, vi } from 'vitest';

// Model, Redis and push fakes so these cases run without MongoDB or Redis.
// The fakes keep the atomic guarantees the consumer relies on: SET NX in Redis,
// the unique (consumer, eventId) index on ProcessedEvent and the unique
// notification id. Every call yields first so parallel runs interleave.
const h = vi.hoisted(() => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const state = {
    users: [] as Array<Record<string, unknown>>,
    notifications: new Map<string, unknown>(),
    processed: new Map<string, Record<string, any>>(),
    failNotificationIds: new Set<string>(),
    redisConfigured: true,
    redisSetError: null as Error | null,
    pagesFetched: 0,
    maxPage: 0,
    cursors: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
    redisStore: new Map<string, { value: string; ttl?: number }>(),
  };

  const redis = {
    status: 'ready',
    set: vi.fn(async (key: string, value: string, _mode?: string, ttl?: number, flag?: string) => {
      await tick();
      if (state.redisSetError) throw state.redisSetError;
      if (flag === 'NX' && state.redisStore.has(key)) return null;
      state.redisStore.set(key, { value, ttl });
      return 'OK';
    }),
    del: vi.fn(async (key: string) => (state.redisStore.delete(key) ? 1 : 0)),
  };

  function makeCursor(filter: Record<string, unknown>, opts?: { batchSize?: number }) {
    const batchSize = opts?.batchSize ?? Number.MAX_SAFE_INTEGER;
    const matching = state.users.filter(
      (u) => filter['notifications.contestAlerts'] === true && (u.notifications as any)?.contestAlerts === true
    );
    const cursor = {
      close: vi.fn(async () => undefined),
      async *[Symbol.asyncIterator]() {
        // Hand out one page per "getMore", the way the driver does with batchSize.
        for (let offset = 0; offset < matching.length; offset += batchSize) {
          await tick();
          const page = matching.slice(offset, offset + batchSize);
          state.pagesFetched++;
          state.maxPage = Math.max(state.maxPage, page.length);
          yield* page;
        }
      },
    };
    state.cursors.push(cursor);
    return cursor;
  }

  const query = { select: vi.fn(), lean: vi.fn(), cursor: vi.fn() };
  const find = vi.fn((filter: Record<string, unknown>) => {
    // No then/exec: awaiting the whole query as an array would not work here.
    const chain = {
      select: query.select.mockImplementation(() => chain),
      lean: query.lean.mockImplementation(() => chain),
      cursor: query.cursor.mockImplementation((opts?: { batchSize?: number }) => makeCursor(filter, opts)),
    };
    return chain;
  });

  const processedKey = (f: { consumer: string; eventId: string }) => `${f.consumer}:${f.eventId}`;
  const ProcessedEvent = {
    create: vi.fn(async (doc: Record<string, any>) => {
      await tick();
      const key = processedKey(doc as any);
      if (state.processed.has(key)) {
        throw Object.assign(new Error('E11000 duplicate key error collection: processedevents'), { code: 11000 });
      }
      state.processed.set(key, { ...doc });
      return doc;
    }),
    updateOne: vi.fn(async (filter: any, update: { $set: Record<string, unknown> }) => {
      const current = state.processed.get(processedKey(filter));
      if (current) Object.assign(current, update.$set);
      return { matchedCount: current ? 1 : 0 };
    }),
    deleteOne: vi.fn(async (filter: any) => ({ deletedCount: state.processed.delete(processedKey(filter)) ? 1 : 0 })),
  };

  const NotificationRecord = {
    updateOne: vi.fn(async (filter: { id: string }, update: { $setOnInsert: unknown }) => {
      await tick();
      if (state.failNotificationIds.has(filter.id)) throw new Error('notification write failed');
      if (state.notifications.has(filter.id)) return { upsertedCount: 0, matchedCount: 1 };
      state.notifications.set(filter.id, update.$setOnInsert);
      return { upsertedCount: 1, matchedCount: 0 };
    }),
  };

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  return { state, redis, find, query, ProcessedEvent, NotificationRecord, logger, sendContestPush: vi.fn(async () => undefined), publish: vi.fn() };
});

vi.mock('../../../shared/redis/client.js', () => ({
  isRedisConfigured: () => h.state.redisConfigured,
  getRedisClient: () => h.redis,
}));
vi.mock('../../../db/models/userSettings.model.js', () => ({ UserSettings: { find: h.find } }));
vi.mock('../../../db/models/notification.model.js', () => ({ NotificationRecord: h.NotificationRecord }));
vi.mock('../../../db/models/processedEvent.model.js', () => ({ ProcessedEvent: h.ProcessedEvent }));
vi.mock('../../../modules/notifications/pushNotification.service.js', () => ({ sendContestPush: h.sendContestPush }));
vi.mock('../../../shared/sse/eventBus.js', () => ({ eventBus: { publish: h.publish } }));
vi.mock('../../../shared/logger.js', () => ({ logger: h.logger, default: h.logger }));

import {
  CONTEST_ALERT_CONSUMER,
  CONTEST_ALERT_USER_BATCH_SIZE,
  handleContestStartingSoon,
} from '../../../modules/notifications/consumers/contestStartingSoon.consumer.js';

const event = (contestId = 'c1') => ({
  eventId: `contest:alert:${contestId}`,
  contestId,
  contestName: 'Codeforces Round 1000',
  platform: 'codeforces' as const,
  startTime: new Date(Date.now() + 30 * 60_000).toISOString(),
  url: 'https://codeforces.com/contest/1000',
});
const dedupKey = (contestId = 'c1') => `devtrack:consumed:contest_alert:contest:alert:${contestId}`;
const inboxKey = (contestId = 'c1') => `${CONTEST_ALERT_CONSUMER}:contest:alert:${contestId}`;

function seedUsers(count: number) {
  h.state.users = Array.from({ length: count }, (_, i) => ({
    userId: `user${i}`,
    notifications: { contestAlerts: true },
  }));
}

function pushCountsPerUser() {
  const counts = new Map<string, number>();
  for (const [userId] of h.sendContestPush.mock.calls as unknown as Array<[string]>) {
    counts.set(userId, (counts.get(userId) ?? 0) + 1);
  }
  return counts;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(h.state, {
    users: [],
    redisConfigured: true,
    redisSetError: null,
    pagesFetched: 0,
    maxPage: 0,
    cursors: [],
  });
  h.state.notifications.clear();
  h.state.processed.clear();
  h.state.failNotificationIds.clear();
  h.state.redisStore.clear();
  h.redis.status = 'ready';
});

describe('contest alert consumer dedup (#724)', () => {
  it('claims with SET NX EX so two concurrent runs alert each user once', async () => {
    seedUsers(5);

    const results = await Promise.all([handleContestStartingSoon(event()), handleContestStartingSoon(event())]);

    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(results.find((r) => r.skipped)?.reason).toBe('duplicate_event');
    expect(results.find((r) => !r.skipped)?.notificationsCreated).toBe(5);
    expect(h.redis.set).toHaveBeenCalledWith(dedupKey(), 'processing', 'EX', 600, 'NX');
    expect(h.sendContestPush).toHaveBeenCalledTimes(5);
    expect([...pushCountsPerUser().values()].every((n) => n === 1)).toBe(true);
    expect(h.find).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
    // Finished events stay deduplicated for 24h and never touch the Mongo fallback.
    expect(h.state.redisStore.get(dedupKey())).toEqual({ value: 'done', ttl: 86400 });
    expect(h.ProcessedEvent.create).not.toHaveBeenCalled();

    const replay = await handleContestStartingSoon(event());
    expect(replay).toMatchObject({ skipped: true, reason: 'duplicate_event' });
    expect(h.sendContestPush).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['unconfigured', () => { h.state.redisConfigured = false; }],
    ['not ready', () => { h.redis.status = 'reconnecting'; }],
  ])('falls back to ProcessedEvent when Redis is %s', async (_label, degrade) => {
    degrade();
    seedUsers(3);

    const results = await Promise.all([handleContestStartingSoon(event()), handleContestStartingSoon(event())]);

    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(results.find((r) => r.skipped)?.reason).toBe('duplicate_event');
    expect(h.redis.set).not.toHaveBeenCalled();
    expect(h.ProcessedEvent.create).toHaveBeenCalledTimes(2);
    expect(h.sendContestPush).toHaveBeenCalledTimes(3);

    const record = h.state.processed.get(inboxKey());
    expect(record).toMatchObject({ consumer: CONTEST_ALERT_CONSUMER, eventId: 'contest:alert:c1', result: { success: true } });
    const ttlMs = (record!.ttlExpiresAt as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 3600_000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3600_000);

    expect(await handleContestStartingSoon(event())).toMatchObject({ skipped: true, reason: 'duplicate_event' });
    expect(h.sendContestPush).toHaveBeenCalledTimes(3);
  });

  it('streams a large opted-in set through a cursor in bounded batches', async () => {
    seedUsers(250);
    h.state.users.push({ userId: 'opted-out', notifications: { contestAlerts: false } });

    const result = await handleContestStartingSoon(event());

    expect(h.find).toHaveBeenCalledWith({ 'notifications.contestAlerts': true });
    expect(h.query.select).toHaveBeenCalledWith('userId platforms notifications.pushNotifications');
    expect(h.query.lean).toHaveBeenCalled();
    expect(h.query.cursor).toHaveBeenCalledWith({ batchSize: CONTEST_ALERT_USER_BATCH_SIZE });
    expect(CONTEST_ALERT_USER_BATCH_SIZE).toBe(100);
    expect(h.state.pagesFetched).toBe(3);
    expect(h.state.maxPage).toBe(100);
    expect(h.state.cursors[0].close).toHaveBeenCalledTimes(1);
    expect(result.notificationsCreated).toBe(250);
    expect(h.sendContestPush).toHaveBeenCalledTimes(250);
    expect(pushCountsPerUser().has('opted-out')).toBe(false);
  });

  it('logs a Redis error and dedups through ProcessedEvent instead', async () => {
    h.state.redisSetError = new Error('Connection is closed.');
    seedUsers(2);

    const first = await handleContestStartingSoon(event());
    const second = await handleContestStartingSoon(event());

    expect(first).toMatchObject({ skipped: false, notificationsCreated: 2 });
    expect(second).toMatchObject({ skipped: true, reason: 'duplicate_event' });
    expect(h.logger.warn).toHaveBeenCalledWith(
      '[contest-alert-consumer] Redis claim failed, using ProcessedEvent fallback',
      { eventId: 'contest:alert:c1', error: 'Connection is closed.' }
    );
    expect(h.state.processed.get(inboxKey())?.result).toEqual({ success: true });
    expect(h.sendContestPush).toHaveBeenCalledTimes(2);
  });

  it('never alerts a user twice when one worker has Redis and the other hits a Redis error', async () => {
    seedUsers(4);
    // Worker A gets the Redis claim; worker B's SET fails and it claims in Mongo instead,
    // so both run. The per-user notification id still allows one alert per user.
    h.redis.set
      .mockImplementationOnce(async (key: string, value: string, _m?: string, ttl?: number) => {
        h.state.redisStore.set(key, { value, ttl });
        return 'OK';
      })
      .mockImplementationOnce(async () => { throw new Error('ECONNRESET'); });

    const results = await Promise.all([handleContestStartingSoon(event()), handleContestStartingSoon(event())]);

    expect(results.every((r) => !r.skipped)).toBe(true);
    expect(results.reduce((sum, r) => sum + r.notificationsCreated, 0)).toBe(4);
    expect(h.sendContestPush).toHaveBeenCalledTimes(4);
    expect([...pushCountsPerUser().values()].every((n) => n === 1)).toBe(true);
  });

  it.each([
    ['Redis', () => undefined],
    ['ProcessedEvent', () => { h.state.redisConfigured = false; }],
  ])('releases the %s claim when processing fails so a retry still alerts', async (_label, setup) => {
    setup();
    seedUsers(3);
    h.state.failNotificationIds.add('notif_contest_c1_user1');

    await expect(handleContestStartingSoon(event())).rejects.toThrow('notification write failed');
    expect(h.state.cursors[0].close).toHaveBeenCalledTimes(1);
    expect(h.state.redisStore.has(dedupKey())).toBe(false);
    expect(h.state.processed.has(inboxKey())).toBe(false);
    expect(h.publish).not.toHaveBeenCalled();

    h.state.failNotificationIds.clear();
    const retry = await handleContestStartingSoon(event());

    // user0 was notified before the failure, so the retry only reaches the other two.
    expect(retry).toMatchObject({ skipped: false, notificationsCreated: 2 });
    expect(h.sendContestPush).toHaveBeenCalledTimes(3);
    expect([...pushCountsPerUser().values()].every((n) => n === 1)).toBe(true);
  });

  it('still reports success when marking the event done fails', async () => {
    seedUsers(1);
    h.redis.set
      .mockImplementationOnce(async () => 'OK')
      .mockImplementationOnce(async () => { throw new Error('READONLY'); });

    const result = await handleContestStartingSoon(event());

    expect(result).toMatchObject({ skipped: false, notificationsCreated: 1 });
    expect(h.logger.warn).toHaveBeenCalledWith(
      '[contest-alert-consumer] Failed to mark contest alert as processed',
      { eventId: 'contest:alert:c1', store: 'redis', error: 'READONLY' }
    );
  });
});
