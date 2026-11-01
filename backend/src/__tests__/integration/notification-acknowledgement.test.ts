import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { User } from '../../db/models/index.js';
import { notificationService } from '../../modules/notifications/notification.service.js';
import notificationRoutes from '../../modules/notifications/notification.routes.js';
import { errorHandler } from '../../middleware/error.js';
import { getRedisClient } from '../../shared/redis/client.js';

// Redis, auth middleware, owner lookup, routes, controllers and service are real.
// Only external identity verification and unrelated delivery/tone are stubbed.
vi.mock('@clerk/backend', () => ({ verifyToken: vi.fn(async (token: string) => {
  if (token === 'synthetic-owner') return { sub: 'notification-ack-owner' };
  if (token === 'synthetic-other') return { sub: 'notification-ack-other' };
  throw new Error('Invalid synthetic token');
}) }));
vi.mock('../../shared/sse/index.js', () => ({ eventBus: { emitNotificationCreated: vi.fn() } }));
vi.mock('../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { getRuntimeState: vi.fn().mockResolvedValue(null) } }));
vi.mock('../../shared/jobs/index.js', () => ({ getNotificationQueue: vi.fn(() => ({ add: vi.fn() })) }));

const owner = new Types.ObjectId().toHexString();
const other = new Types.ObjectId().toHexString();
const key = (id = owner) => `notifications:${id}`;
const counter = (id = owner) => `notifications:unread:${id}`;
const ownedKeys = [owner, other].flatMap(id => [key(id), counter(id), `notifications:prefs:${id}`]);
let server: Server;
let base: string;

beforeAll(async () => {
  // Fail instead of presenting Redis-offline degradation as persistence coverage.
  expect(await getRedisClient().ping()).toBe('PONG');
  expect(await getRedisClient().info('server')).toContain('redis_version:');
  const app = express();
  app.use('/api/v1/notifications', notificationRoutes);
  app.use(errorHandler);
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/notifications`;
});
beforeEach(async () => {
  await getRedisClient().del(...ownedKeys);
  await User.create([
    { _id: owner, clerkId: 'notification-ack-owner', username: 'ackowner', email: 'ackowner@example.test', displayName: 'Synthetic Owner' },
    { _id: other, clerkId: 'notification-ack-other', username: 'ackother', email: 'ackother@example.test', displayName: 'Synthetic Other' },
  ]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await getRedisClient().del(...ownedKeys);
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function create(userId = owner) {
  return notificationService.create(userId, 'system', 'Synthetic notice', 'Synthetic body', { nested: { tags: [], value: null }, values: [1, 'two'] });
}
async function raw(userId = owner) {
  const values = await getRedisClient().zrange(key(userId), 0, -1, 'WITHSCORES');
  return Array.from({ length: values.length / 2 }, (_, index) => ({ member: values[index * 2], score: values[index * 2 + 1], notification: JSON.parse(values[index * 2]) }));
}
async function assertState(total: number, unread: number, read: number) {
  const result = await notificationService.getNotifications(owner, 100);
  const stored = await raw();
  expect(result.total).toBe(total);
  expect(result.unread).toBe(unread);
  expect(result.notifications.filter(item => item.read)).toHaveLength(read);
  expect(stored).toHaveLength(total);
  expect(new Set(stored.map(item => item.notification.id)).size).toBe(total);
  expect(await getRedisClient().zcard(key())).toBe(total);
  expect(await notificationService.getUnreadCount(owner)).toBeGreaterThanOrEqual(0);
  return stored;
}
async function acknowledge(mode: string, id: string) {
  if (mode === 'single') await notificationService.markAsRead(owner, id);
  else await notificationService.markAllAsRead(owner);
}

describe('notification acknowledgements with real Redis', () => {
  it('creates, acknowledges and repeatedly replays one stored notification without duplicates', async () => {
    const notice = await create(); const before = (await raw())[0];
    await assertState(1, 1, 0);
    await notificationService.markAsRead(owner, notice.id);
    const [after] = await assertState(1, 0, 1);
    expect(after.notification).toEqual({ ...before.notification, read: true });
    expect(after.score).toBe(before.score);
    expect(after.member).not.toBe(before.member);
    for (let i = 0; i < 3; i++) await notificationService.markAsRead(owner, notice.id);
    expect(await assertState(1, 0, 1)).toEqual([after]);
  });
  it('marks several notifications all read and preserves every identity', async () => {
    const notices = [await create(), await create(), await create()];
    await notificationService.markAllAsRead(owner);
    const stored = await assertState(3, 0, 3);
    expect(stored.map(item => item.notification.id).sort()).toEqual(notices.map(item => item.id).sort());
    await notificationService.markAllAsRead(owner);
    expect(await assertState(3, 0, 3)).toEqual(stored);
  });
  it('acknowledges mixed read/unread state without counting the read item twice', async () => {
    const first = await create(); await create(); await create();
    await notificationService.markAsRead(owner, first.id);
    await assertState(3, 2, 1);
    await notificationService.markAllAsRead(owner);
    await assertState(3, 0, 3);
  });
  it('treats an unknown ID and another owner ID as no-ops', async () => {
    const first = await create(); const second = await create(other);
    await notificationService.markAsRead(owner, 'missing');
    await notificationService.markAsRead(owner, second.id);
    await assertState(1, 1, 0);
    expect((await raw())[0].notification.id).toBe(first.id);
  });
  it('keeps empty mark-all safe without creating keys', async () => {
    await notificationService.markAllAsRead(owner);
    await assertState(0, 0, 0);
    expect(await getRedisClient().exists(key(), counter())).toBe(0);
  });
  it.each(['single', 'all'])('isolates other users during %s acknowledgement', async mode => {
    const notice = await create(); await create(other);
    await getRedisClient().pexpire(key(other), 120_000);
    const before = await raw(other), count = await getRedisClient().get(counter(other));
    const ttl = await getRedisClient().pttl(key(other));
    await acknowledge(mode, notice.id);
    expect(await raw(other)).toEqual(before);
    expect(await getRedisClient().get(counter(other))).toBe(count);
    const remaining = await getRedisClient().pttl(key(other));
    expect(remaining).toBeGreaterThan(ttl - 2_000);
    expect(remaining).toBeLessThanOrEqual(ttl);
  });
  it.each(['single', 'all'])('preserves single-member TTL for %s without restarting expiry', async mode => {
    const notice = await create(); await getRedisClient().pexpire(key(), 120_000);
    const before = await getRedisClient().pttl(key());
    await acknowledge(mode, notice.id);
    const after = await getRedisClient().pttl(key());
    expect(after).toBeGreaterThan(before - 2_000);
    expect(after).toBeLessThanOrEqual(before);
    await assertState(1, 0, 1);
  });
  it('preserves scores, ordering, optional fields and full serialized payloads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01')); await create();
    vi.setSystemTime(new Date('2026-01-02'));
    const second = await notificationService.create(owner, 'inactivity', 'Notice', 'Body', { emptyArray: [], emptyObject: {}, value: null, text: '✓' });
    const before = await raw();
    // The Redis score is authoritative even when it differs from createdAt.
    await getRedisClient().zadd(key(), 123, before[0].member);
    const ordered = await raw();
    await notificationService.markAsRead(owner, second.id);
    await notificationService.markAllAsRead(owner);
    const after = await assertState(2, 0, 2);
    expect(after.map(item => item.score)).toEqual(ordered.map(item => item.score));
    expect(after.map(item => item.notification)).toEqual(ordered.map(item => ({ ...item.notification, read: true })));
  });
  it.each(['single', 'all'])('preserves a deliberately nonexpiring key during %s', async mode => {
    const notice = await create(); await getRedisClient().persist(key());
    await acknowledge(mode, notice.id);
    expect(await getRedisClient().pttl(key())).toBe(-1);
  });
  it.each(['single', 'all', 'mixed'])('serializes concurrent %s acknowledgements with one logical transition per member', async mode => {
    const notice = await create(); if (mode !== 'single') { await create(); await create(); }
    const redis = getRedisClient(), original = redis.zrange.bind(redis);
    const count = 12;
    let arrivals = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(redis, 'zrange').mockImplementation(((...args: Parameters<typeof redis.zrange>) => {
      return original(...args).then(async result => {
        if (++arrivals <= count) { if (arrivals === count) release(); await barrier; }
        return result;
      });
    }) as typeof redis.zrange);
    await Promise.all(Array.from({ length: count }, (_, index) => mode === 'all' || (mode === 'mixed' && index % 2) ? notificationService.markAllAsRead(owner) : notificationService.markAsRead(owner, notice.id)));
    vi.restoreAllMocks();
    expect(arrivals).toBeGreaterThanOrEqual(count);
    await assertState(mode === 'single' ? 1 : 3, 0, mode === 'single' ? 1 : 3);
  });
  it.each(['single', 'all'])('fails before changing stored members when the counter has a wrong Redis type (%s)', async mode => {
    const notice = await create(); const before = await raw();
    await getRedisClient().del(counter()); await getRedisClient().lpush(counter(), 'invalid');
    await expect(acknowledge(mode, notice.id)).rejects.toThrow();
    expect(await raw()).toEqual(before);
    expect(await getRedisClient().lrange(counter(), 0, -1)).toEqual(['invalid']);
  });
  it.each(['single', 'all'])('rejects malformed numeric counters before membership changes (%s)', async mode => {
    const notice = await create(); const before = await raw();
    await getRedisClient().set(counter(), 'not-an-integer');
    await expect(acknowledge(mode, notice.id)).rejects.toThrow();
    expect(await raw()).toEqual(before);
    expect(await getRedisClient().get(counter())).toBe('not-an-integer');
  });
  it('preserves the unread counter TTL while acknowledging only one of several items', async () => {
    const notice = await create(); await create();
    await getRedisClient().pexpire(counter(), 120_000);
    const before = await getRedisClient().pttl(counter());
    await notificationService.markAsRead(owner, notice.id);
    await assertState(2, 1, 1);
    const after = await getRedisClient().pttl(counter());
    expect(after).toBeGreaterThan(before - 2_000);
    expect(after).toBeLessThanOrEqual(before);
  });
  it('does not resurrect a member removed after the client snapshot', async () => {
    const notice = await create(), redis = getRedisClient();
    const original = redis.zrange.bind(redis);
    vi.spyOn(redis, 'zrange').mockImplementationOnce(((...args: Parameters<typeof redis.zrange>) => original(...args).then(async members => {
      await redis.del(key()); return members;
    })) as typeof redis.zrange);
    await notificationService.markAsRead(owner, notice.id);
    vi.restoreAllMocks();
    expect(await redis.exists(key())).toBe(0);
    expect(await redis.get(counter())).toBe('1'); // No live member transitioned; no historical counter repair.
  });
  it('keeps a fully created notification arriving after a mark-all snapshot unread and counted', async () => {
    const first = await create(), redis = getRedisClient();
    const original = redis.zrange.bind(redis);
    let laterId = '';
    vi.spyOn(redis, 'zrange').mockImplementationOnce(((...args: Parameters<typeof redis.zrange>) => original(...args).then(async members => {
      laterId = (await create()).id; return members;
    })) as typeof redis.zrange);
    await notificationService.markAllAsRead(owner); vi.restoreAllMocks();
    const stored = await assertState(2, 1, 1);
    expect(stored.find(item => item.notification.id === first.id)?.notification.read).toBe(true);
    expect(stored.find(item => item.notification.id === laterId)?.notification.read).toBe(false);
  });
  it('retries safely after the server executes EVAL but its reply is lost', async () => {
    const notice = await create(), redis = getRedisClient();
    const original = redis.eval.bind(redis);
    vi.spyOn(redis, 'eval').mockImplementationOnce((async (...args: Parameters<typeof redis.eval>) => {
      await original(...args); throw new Error('Injected lost reply after execution');
    }) as unknown as typeof redis.eval);
    await expect(notificationService.markAsRead(owner, notice.id)).rejects.toThrow('lost reply');
    vi.restoreAllMocks();
    const stored = await assertState(1, 0, 1);
    await notificationService.markAsRead(owner, notice.id);
    expect(await assertState(1, 0, 1)).toEqual(stored);
  });
  it.each(['0', '-1', '01'])('does not produce negative or malformed counters from stored value %j', async value => {
    const notice = await create(); await getRedisClient().set(counter(), value);
    await notificationService.markAsRead(owner, notice.id);
    expect(await getRedisClient().get(counter())).toBe('0');
    await assertState(1, 0, 1);
  });
});

describe('notification acknowledgement HTTP compatibility', () => {
  it.each(['single', 'all'])('acknowledges through actual authenticated %s route and reads persisted state', async mode => {
    const notice = await create();
    const route = mode === 'single' ? `${notice.id}/read` : 'read-all';
    const response = await fetch(`${base}/${route}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-owner' } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true });
    const readback = await fetch(base, { headers: { Authorization: 'Bearer synthetic-owner' } });
    expect(readback.status).toBe(200);
    expect(await readback.json()).toMatchObject({ total: 1, unread: 0, notifications: [{ id: notice.id, read: true }] });
    await assertState(1, 0, 1);
  });
  it.each(['', 'Bearer invalid-token'])('rejects unauthenticated/invalid acknowledgement %j without mutation', async authorization => {
    const notice = await create();
    for (const route of [`${notice.id}/read`, 'read-all']) {
      const response = await fetch(`${base}/${route}`, { method: 'POST', headers: authorization ? { Authorization: authorization } : {} });
      expect(response.status).toBe(401);
    }
    await assertState(1, 1, 0);
  });
});
