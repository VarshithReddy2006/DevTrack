import { describe, it, expect, vi } from 'vitest';
import { notificationService as service } from './notification.service.js';
import { NotificationRecord } from '../../db/models/notification.model.js';
import { UserSettings } from '../../db/models/userSettings.model.js';

vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => { throw new Error('Redis offline'); },
}));
vi.mock('../../shared/sse/index.js', () => ({ eventBus: { emitNotificationCreated: vi.fn().mockRejectedValue(new Error('offline')) } }));
vi.mock('../runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: { getRuntimeState: vi.fn().mockResolvedValue(null) },
}));
vi.mock('../../shared/jobs/index.js', () => ({ getNotificationQueue: vi.fn() }));

describe('durable notifications with Redis offline', () => {
  it('persists, paginates unread before limiting, and acknowledges only owned records', async () => {
    const first = await service.create('owner', 'system', 'First', 'Body');
    expect(first).not.toBeNull();
    await service.create('owner', 'system', 'Second', 'Body');
    await service.create('other', 'system', 'Private', 'Body');
    await service.markAsRead('other', first!.id);
    expect(await service.getUnreadCount('owner')).toBe(2);
    await Promise.all([service.markAsRead('owner', first!.id), service.markAsRead('owner', first!.id)]);
    const unread = await service.getNotifications('owner', 1, 0, true);
    expect(unread.total).toBe(1);
    expect(unread.notifications).toHaveLength(1);
    expect(unread.notifications[0].read).toBe(false);
    expect(await NotificationRecord.countDocuments({ userId: 'owner' })).toBe(2);
    await service.markAllAsRead('owner');
    expect(await service.getUnreadCount('owner')).toBe(0);
    expect(await service.getUnreadCount('other')).toBe(1);
  });

  it('honors durable preferences and returns null for disabled types', async () => {
    await service.updatePreferences('owner', { types: { system: false } as any });
    expect(await service.create('owner', 'system', 'Disabled', 'Body')).toBeNull();
    expect(await NotificationRecord.countDocuments()).toBe(0);
    expect((await service.getPreferences('owner')).types.achievement).toBe(true);
  });

  it('delivers a one-day streak reminder unless disabled in settings', async () => {
    const userId = '000000000000000000000024';
    await service.triggerStreakReminder(userId, 0);
    expect(await NotificationRecord.countDocuments({ userId })).toBe(0);
    await service.triggerStreakReminder(userId, 1);
    expect(await NotificationRecord.countDocuments({ userId, type: 'streak_reminder' })).toBe(1);

    await UserSettings.create({ userId, notifications: { streakReminder: false } });
    await service.triggerStreakReminder(userId, 4);
    expect(await NotificationRecord.countDocuments({ userId, type: 'streak_reminder' })).toBe(1);
  });

  it('excludes expired records before TTL cleanup and removes them on cleanup', async () => {
    const notification = await service.create('owner', 'system', 'Expired', 'Body');
    await NotificationRecord.updateOne({ id: notification!.id }, { $set: { expiresAt: new Date(0) } });
    expect((await service.getNotifications('owner')).total).toBe(0);
    expect(await service.getUnreadCount('owner')).toBe(0);
    await service.cleanupExpired();
    expect(await NotificationRecord.countDocuments()).toBe(0);
  });
});
