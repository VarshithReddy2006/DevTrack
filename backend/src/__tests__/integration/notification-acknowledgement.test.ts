import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { User } from '../../db/models/index.js';
import { notificationService } from '../../modules/notifications/notification.service.js';
import notificationRoutes from '../../modules/notifications/notification.routes.js';
import { errorHandler } from '../../middleware/error.js';

// Auth middleware, ownership, routes, controllers and MongoDB persistence are real.
vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => { throw new Error('Redis offline'); },
}));
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
let server: Server;
let base: string;

beforeAll(async () => {
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_synthetic_notifications');
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
  await User.create([
    { _id: owner, clerkId: 'notification-ack-owner', username: 'ackowner', email: 'ackowner@example.test', displayName: 'Synthetic Owner' },
    { _id: other, clerkId: 'notification-ack-other', username: 'ackother', email: 'ackother@example.test', displayName: 'Synthetic Other' },
  ]);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.unstubAllEnvs();
});

async function create(userId = owner) {
  const result = await notificationService.create(userId, 'system', 'Synthetic notice', 'Synthetic body');
  if (!result) throw new Error('Synthetic notification unexpectedly disabled');
  return result;
}

async function post(path: string, token = 'synthetic-owner') {
  return fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
}

describe('durable notification acknowledgements through authenticated routes', () => {
  it('keeps repeated concurrent acknowledgements idempotent and owner scoped', async () => {
    const notice = await create();
    expect((await post('/' + notice.id + '/read', 'synthetic-other')).status).toBe(200);
    expect(await notificationService.getUnreadCount(owner)).toBe(1);
    const results = await Promise.all(Array.from({ length: 10 }, () => post('/' + notice.id + '/read')));
    expect(results.every(result => result.status === 200)).toBe(true);
    const state = await notificationService.getNotifications(owner);
    expect(state.total).toBe(1);
    expect(state.unread).toBe(0);
    expect(state.notifications[0].read).toBe(true);
  });

  it('preserves other users unread state when marking all as read', async () => {
    await Promise.all([create(), create(), create(other)]);
    await notificationService.markAllAsRead(owner);
    expect(await notificationService.getUnreadCount(owner)).toBe(0);
    expect(await notificationService.getUnreadCount(other)).toBe(1);
  });
});
