// src/modules/notifications/notification.service.ts — Notification + Engagement Platform
// Phase-B: In-app notifications, event fanout, digest support

import { NotificationRecord, NotificationPreference } from '../../db/models/notification.model.js';
import { eventBus } from '../../shared/sse/index.js';
import { getRedisClient } from '../../shared/redis/client.js';
import { logger } from '../../shared/logger.js';
import { getNotificationQueue } from '../../shared/jobs/index.js';
import { unifiedRuntimeStateService } from '../runtime-state/unifiedRuntimeState.service.js';

// Notification types
export type NotificationType =
  | 'streak_reminder'    // Your streak is at risk
  | 'streak_milestone'   // You hit a streak milestone
  | 'level_up'           // You leveled up
  | 'milestone'          // Problem solving milestone
  | 'achievement'        // Badge earned
  | 'leaderboard_update' // Rank changed
  | 'inactivity'         // Come back reminder
  | 'system';            // System announcements

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
  expiresAt?: Date;
  tone?: 'encouraging' | 'calm' | 'celebratory' | 'gentle-nudge' | 'supportive' | 'silent';
}

// Notification preferences
export interface NotificationPreferences {
  enableInApp: boolean;
  enablePush: boolean; // placeholder for future
  digestFrequency: 'realtime' | 'daily' | 'weekly' | 'none';
  types: Record<NotificationType, boolean>;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  enableInApp: true,
  enablePush: false,
  digestFrequency: 'realtime',
  types: {
    streak_reminder: true,
    streak_milestone: true,
    level_up: true,
    milestone: true,
    achievement: true,
    leaderboard_update: false,
    inactivity: true,
    system: true,
  },
};

export const notificationService = {
  // ─── Create and deliver notification ─────────────────────────────────
  async create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>
  ): Promise<Notification | null> {
    const preferences = await this.getPreferences(userId);

    // Check if user wants this type
    if (!preferences.types[type]) {
      logger.debug('[notifications] Type disabled by user', { userId, type });
      return null;
    }

    // Derive tone from user behavioral state
    const tone = await this.deriveTone(userId, type);

    const notification: Notification = {
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      userId,
      type,
      title,
      message,
      data,
      read: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + (type === 'inactivity' ? 7 : 30) * 86400000),
      tone,
    };

    // Persist before attempting cache or realtime delivery.
    await this.storeNotification(userId, notification);


    // Send real-time if enabled
    if (preferences.enableInApp) {
      await this.sendRealtime(userId, notification).catch(error => logger.warn('[notifications] Realtime delivery failed', { error }));
    }

    // Queue for digest if not realtime
    if (preferences.digestFrequency !== 'realtime' && preferences.digestFrequency !== 'none') {
      await this.queueForDigest(userId, notification).catch(error => logger.warn('[notifications] Digest queue unavailable', { error }));
    }

    logger.info('[notifications] Created', { userId, type, id: notification.id });

    return notification;
  },

  // ─── Durable storage and best-effort cache ───────────────────────────
  async storeNotification(userId: string, notification: Notification): Promise<void> {
    await NotificationRecord.create({ ...notification, userId });
    // Cache delivery is best effort; MongoDB is authoritative.
    try {
      const redis = getRedisClient();
      await redis.set(`notification:${userId}:${notification.id}`, JSON.stringify(notification), 'EX', 300);
    } catch (error) {
      logger.warn('[notifications] Cache unavailable', { error });
    }
  },

  // ─── Send real-time via SSE ───────────────────────────────────────────
  async sendRealtime(userId: string, notification: Notification): Promise<void> {
    await eventBus.emitNotificationCreated(
      userId,
      notification.id,
      notification.type,
      notification.title,
      notification.message,
      notification.tone || 'calm',
      'medium'
    );
  },

  // ─── Queue for digest batching ───────────────────────────────────────
  async queueForDigest(userId: string, notification: Notification): Promise<void> {
    const queue = getNotificationQueue();
    await queue.add('digest-batch', {
      userId,
      notification,
      queuedAt: Date.now(),
    });
  },

  // ─── Get user notifications ───────────────────────────────────────────
  async getNotifications(
    userId: string,
    limit = 20,
    offset = 0,
    unreadOnly = false
  ): Promise<{ notifications: Notification[]; total: number; unread: number }> {
    const active = { userId, expiresAt: { $gt: new Date() } };
    const filter = unreadOnly ? { ...active, read: false } : active;
    const safeLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 20;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
    const [records, total, unread] = await Promise.all([
      NotificationRecord.find(filter).sort({ createdAt: -1, id: -1 }).skip(safeOffset).limit(safeLimit).lean(),
      NotificationRecord.countDocuments(filter),
      NotificationRecord.countDocuments({ ...active, read: false }),
    ]);
    const notifications = records.map(({ _id, __v, ...record }) => record as Notification);
    return { notifications, total, unread };
  },

  async markAsRead(userId: string, notificationId: string): Promise<void> {
    await NotificationRecord.updateOne({ userId, id: notificationId, read: false }, { $set: { read: true } });
    await this.invalidateCachedNotification(userId, notificationId);
  },

  async markAllAsRead(userId: string): Promise<void> {
    await NotificationRecord.updateMany({ userId, read: false }, { $set: { read: true } });
    // Cached records are delivery hints only; reads always use MongoDB.
  },

  async invalidateCachedNotification(userId: string, id: string): Promise<void> {
    try {
      await getRedisClient().del(`notification:${userId}:${id}`);
    } catch (error) {
      logger.warn('[notifications] Cache invalidation failed', { error });
    }
  },

  async getUnreadCount(userId: string): Promise<number> {
    return NotificationRecord.countDocuments({ userId, read: false, expiresAt: { $gt: new Date() } });
  },

  // ─── Notification preferences ────────────────────────────────────────
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const stored = await NotificationPreference.findOne({ userId }).lean();
    const preferences = stored?.preferences as Partial<NotificationPreferences> | undefined;
    return { ...DEFAULT_PREFERENCES, ...preferences, types: { ...DEFAULT_PREFERENCES.types, ...preferences?.types } };
  },

  async updatePreferences(userId: string, updates: Partial<NotificationPreferences>): Promise<void> {
    const fields: Record<string, unknown> = {};
    for (const key of ['enableInApp', 'enablePush', 'digestFrequency'] as const) {
      if (updates[key] !== undefined) fields[`preferences.${key}`] = updates[key];
    }
    for (const [type, enabled] of Object.entries(updates.types || {})) {
      if (type in DEFAULT_PREFERENCES.types) fields[`preferences.types.${type}`] = enabled;
    }
    await NotificationPreference.updateOne({ userId }, { $set: fields }, { upsert: true, runValidators: true });
  },

  // ─── Derive tone from user behavioral state ─────────────────────────────
  async deriveTone(userId: string, type: NotificationType): Promise<'encouraging' | 'calm' | 'celebratory' | 'gentle-nudge' | 'supportive' | 'silent'> {
    try {
      const userState = await unifiedRuntimeStateService.getRuntimeState(userId);
      if (!userState) {
        return 'calm'; // Default tone
      }

      const { emotionalState, fatigueState, recoveryState } = userState;

      // Recovery state takes precedence
      if (recoveryState === 'active') {
        return 'encouraging';
      }

      // High fatigue → calm tone
      if (fatigueState === 'high' || fatigueState === 'burnout') {
        return 'calm';
      }

      // Notification type-based tone adjustments
      if (type === 'streak_reminder' || type === 'inactivity') {
        return 'gentle-nudge';
      }

      if (type === 'level_up' || type === 'streak_milestone' || type === 'achievement') {
        return 'celebratory';
      }

      // Emotional state mapping
      switch (emotionalState) {
        case 'discouraged':
        case 'overwhelmed':
          return 'supportive';
        case 'motivated':
          return 'celebratory';
        case 'focused':
          return 'calm';
        case 'neutral':
          return 'encouraging';
        default:
          return 'encouraging';
      }
    } catch (error) {
      logger.error('[notifications] Failed to derive tone', { error, userId });
      return 'calm'; // Safe default
    }
  },

  // ─── Engagement triggers ─────────────────────────────────────────────
  async triggerStreakReminder(userId: string, currentStreak: number): Promise<void> {
    if (currentStreak >= 3) {
      await this.create(
        userId,
        'streak_reminder',
        'Keep your streak alive!',
        `You have a ${currentStreak}-day streak. Don't break it!`
      );
    }
  },

  async triggerStreakMilestone(userId: string, streakDays: number): Promise<void> {
    await this.create(
      userId,
      'streak_milestone',
      `${streakDays} Day Streak! 🎉`,
      `Amazing! You've maintained a ${streakDays}-day coding streak.`
    );
  },

  async triggerLevelUp(userId: string, newLevel: number): Promise<void> {
    await this.create(
      userId,
      'level_up',
      `Level Up! 🚀`,
      `Congratulations! You've reached level ${newLevel}.`
    );
  },

  async triggerInactivityReminder(userId: string, daysSinceActive: number): Promise<void> {
    await this.create(
      userId,
      'inactivity',
      'We miss you!',
      `It's been ${daysSinceActive} days since your last activity. Come back and keep your streak!`
    );
  },

  // ─── Cleanup expired notifications ─────────────────────────────────
  async cleanupExpired(): Promise<number> {
    const result = await NotificationRecord.deleteMany({ expiresAt: { $lte: new Date() } });
    return result.deletedCount;
  },
};

export default notificationService;
