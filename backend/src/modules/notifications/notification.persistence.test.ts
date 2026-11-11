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

  it('updates and returns full preferences and merges with defaults', async () => {
    const defaults = await service.getPreferences('pref-user');
    expect(defaults.enableInApp).toBe(true);
    expect(defaults.digestFrequency).toBe('realtime');
    expect(defaults.types.streak_reminder).toBe(true);

    const updated = await service.updatePreferences('pref-user', {
      digestFrequency: 'daily',
      types: { streak_reminder: false } as any,
    });

    expect(updated.digestFrequency).toBe('daily');
    expect(updated.types.streak_reminder).toBe(false);
    expect(updated.types.achievement).toBe(true);

    const fetched = await service.getPreferences('pref-user');
    expect(fetched.digestFrequency).toBe('daily');
    expect(fetched.types.streak_reminder).toBe(false);
  });

  it('deletes an owned notification and isolates cross-tenant deletion', async () => {
    const userA = 'user-alice';
    const userB = 'user-bob';

    const notifA = await service.create(userA, 'system', 'Alice Notif', 'Body');
    const notifB = await service.create(userB, 'system', 'Bob Notif', 'Body');

    // Bob cannot delete Alice's notification
    const bobDeleteAlice = await service.deleteNotification(userB, notifA!.id);
    expect(bobDeleteAlice).toBe(false);
    expect((await service.getNotifications(userA)).total).toBe(1);

    // Alice can delete her own notification
    const aliceDelete = await service.deleteNotification(userA, notifA!.id);
    expect(aliceDelete).toBe(true);
    expect((await service.getNotifications(userA)).total).toBe(0);

    // Deleting a non-existent or already deleted notification returns false
    const deleteAgain = await service.deleteNotification(userA, notifA!.id);
    expect(deleteAgain).toBe(false);

    // Bob's notification is untouched
    expect((await service.getNotifications(userB)).total).toBe(1);
  });

  it('clears only read notifications when readOnly=true, and all when readOnly=false', async () => {
    const userId = 'user-clear';
    const n1 = await service.create(userId, 'system', 'N1', 'B1');
    const n2 = await service.create(userId, 'system', 'N2', 'B2');
    const n3 = await service.create(userId, 'system', 'N3', 'B3');

    // Mark n1 and n2 as read
    await service.markAsRead(userId, n1!.id);
    await service.markAsRead(userId, n2!.id);

    // Clear read-only
    const clearedRead = await service.clearNotifications(userId, true);
    expect(clearedRead).toBe(2);

    // Only n3 remains
    const remaining = await service.getNotifications(userId);
    expect(remaining.total).toBe(1);
    expect(remaining.notifications[0].id).toBe(n3!.id);

    // Clear all
    const clearedAll = await service.clearNotifications(userId, false);
    expect(clearedAll).toBe(1);
    expect((await service.getNotifications(userId)).total).toBe(0);
  });
});
