import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationRecord, NotificationPreference } from '../../../db/models/notification.model.js';
import { errorHandler } from '../../../middleware/error.js';
import notificationRoutes from '../../../modules/notifications/notification.routes.js';
import { notificationService } from '../../../modules/notifications/notification.service.js';

vi.mock('../../../shared/redis/client.js', () => ({
  getRedisClient: () => { throw new Error('Redis offline'); },
}));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitNotificationCreated: vi.fn().mockRejectedValue(new Error('offline')) } }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: { getRuntimeState: vi.fn().mockResolvedValue(null) },
}));
vi.mock('../../../shared/jobs/index.js', () => ({ getNotificationQueue: vi.fn() }));

vi.mock('../../../middleware/index.js', async () => {
  const { validateBody, validateParams } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  const { commonErrors } = await import('../../../shared/response.js');
  return {
    validateBody,
    validateParams,
    asyncHandler,
    authMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const auth = req.get('authorization');
      if (!auth || !auth.startsWith('Bearer ')) {
        commonErrors.unauthorized(res);
        return;
      }
      const token = auth.replace('Bearer ', '');
      if (token === 'owner-token') {
        Object.assign(req, { user: { id: '000000000000000000000001' } });
      } else if (token === 'other-token') {
        Object.assign(req, { user: { id: '000000000000000000000002' } });
      } else {
        commonErrors.unauthorized(res);
        return;
      }
      next();
    },
  };
});

describe('Notification preferences and deletion HTTP routes', () => {
  const ownerId = '000000000000000000000001';
  const otherId = '000000000000000000000002';
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/notifications', notificationRoutes);
    app.use(errorHandler);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/notifications`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    await NotificationRecord.deleteMany({});
    await NotificationPreference.deleteMany({});
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${baseUrl}/preferences`);
    expect(res.status).toBe(401);

    const deleteRes = await fetch(`${baseUrl}/notif_123`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(401);
  });

  it('retrieves default preferences and updates them via PATCH', async () => {
    const getRes = await fetch(`${baseUrl}/preferences`, {
      headers: { Authorization: 'Bearer owner-token' },
    });
    expect(getRes.status).toBe(200);
    const defaults = await getRes.json();
    expect(defaults.enableInApp).toBe(true);
    expect(defaults.digestFrequency).toBe('realtime');
    expect(defaults.types.system).toBe(true);

    const patchRes = await fetch(`${baseUrl}/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      },
      body: JSON.stringify({
        digestFrequency: 'weekly',
        types: { system: false },
      }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.digestFrequency).toBe('weekly');
    expect(updated.types.system).toBe(false);
    expect(updated.types.achievement).toBe(true);
  });

  it('rejects invalid preference payloads with 400', async () => {
    const badRes = await fetch(`${baseUrl}/preferences`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owner-token',
      },
      body: JSON.stringify({
        digestFrequency: 'every_minute', // not in enum
      }),
    });
    expect(badRes.status).toBe(400);
  });

  it('deletes an owned notification and isolates other users (returning 404)', async () => {
    const ownerNotif = await notificationService.create(ownerId, 'system', 'Owner Notif', 'Test Body');
    expect(ownerNotif).not.toBeNull();

    // Other user attempts to delete owner's notification -> 404
    const forbiddenRes = await fetch(`${baseUrl}/${ownerNotif!.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer other-token' },
    });
    expect(forbiddenRes.status).toBe(404);
    expect(await NotificationRecord.countDocuments({ id: ownerNotif!.id })).toBe(1);

    // Owner deletes their own notification -> 200
    const ownerDeleteRes = await fetch(`${baseUrl}/${ownerNotif!.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer owner-token' },
    });
    expect(ownerDeleteRes.status).toBe(200);
    const deleteJson = await ownerDeleteRes.json();
    expect(deleteJson.success).toBe(true);
    expect(await NotificationRecord.countDocuments({ id: ownerNotif!.id })).toBe(0);

    // Repeated delete returns 404
    const repeatedDelete = await fetch(`${baseUrl}/${ownerNotif!.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer owner-token' },
    });
    expect(repeatedDelete.status).toBe(404);
  });

  it('clears read notifications via DELETE /', async () => {
    const n1 = await notificationService.create(ownerId, 'system', 'N1', 'B1');
    const n2 = await notificationService.create(ownerId, 'system', 'N2', 'B2');
    const n3 = await notificationService.create(ownerId, 'system', 'N3', 'B3');

    await notificationService.markAsRead(ownerId, n1!.id);
    await notificationService.markAsRead(ownerId, n2!.id);

    // Default clear: readOnly = true
    const clearRes = await fetch(`${baseUrl}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer owner-token' },
    });
    expect(clearRes.status).toBe(200);
    const clearJson = await clearRes.json();
    expect(clearJson.success).toBe(true);
    expect(clearJson.deletedCount).toBe(2);

    expect(await NotificationRecord.countDocuments({ userId: ownerId })).toBe(1);

    // Clear all: readOnly = false
    const clearAllRes = await fetch(`${baseUrl}?readOnly=false`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer owner-token' },
    });
    expect(clearAllRes.status).toBe(200);
    const clearAllJson = await clearAllRes.json();
    expect(clearAllJson.deletedCount).toBe(1);
    expect(await NotificationRecord.countDocuments({ userId: ownerId })).toBe(0);
  });
});
