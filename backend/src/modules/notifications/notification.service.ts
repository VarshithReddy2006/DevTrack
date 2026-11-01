// src/modules/notifications/notification.service.ts — Notification + Engagement Platform
// Phase-B: In-app notifications, event fanout, digest support

import { Types } from 'mongoose';
import { User } from '../../db/models/index.js';
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

// Redis key helpers
const NOTIF_KEYS = {
  userNotifications: (userId: string) => `notifications:${userId}`,
  unreadCount: (userId: string) => `notifications:unread:${userId}`,
  userPreferences: (userId: string) => `notifications:prefs:${userId}`,
};

// Compare exact stored members and publish their read replacements together with
// the counter change. A stale acknowledgement finds no old member and is inert.
// Replacements are serialized in JS so nested arrays/nulls retain their shape.
const ACKNOWLEDGE_NOTIFICATIONS = `
local updates = {}
for i = 1, #ARGV, 2 do
  local score = redis.call('ZSCORE', KEYS[1], ARGV[i])
  if score then
    updates[#updates + 1] = { ARGV[i], ARGV[i + 1], score }
  end
end
if #updates == 0 then return 0 end

-- Validate counter state before any writes: Lua errors do not roll back writes.
local storedCount = redis.call('GET', KEYS[2])
local count = tonumber(storedCount or '0')
if not count or (storedCount and not string.match(storedCount, '^%-?%d+$'))
  or math.abs(count) > 9007199254740991 then
  return redis.error_reply('Invalid notification unread counter')
end

for _, update in ipairs(updates) do
  -- Insert first: removing the last old member must not delete the key/its TTL.
  redis.call('ZADD', KEYS[1], update[3], update[2])
  redis.call('ZREM', KEYS[1], update[1])
end
if storedCount then
  local remaining = math.max(0, count - #updates)
  redis.call('SET', KEYS[2], string.format('%.0f', remaining), 'KEEPTTL')
end
return #updates
`;

async function acknowledgeNotifications(userId: string, notificationId?: string): Promise<void> {
  const redis = getRedisClient();
  const key = NOTIF_KEYS.userNotifications(userId);
  const members = await redis.zrange(key, 0, -1);
  const replacements: string[] = [];
  for (const member of members) {
    const notification = JSON.parse(member) as Notification;
    if (!notification.read && (notificationId === undefined || notification.id === notificationId)) {
      replacements.push(member, JSON.stringify({ ...notification, read: true }));
      if (notificationId !== undefined) break;
    }
  }
  if (replacements.length) {
    await redis.eval(ACKNOWLEDGE_NOTIFICATIONS, 2, key, NOTIF_KEYS.unreadCount(userId), ...replacements);
  }
}

export const notificationService = {
  // ─── Create and deliver notification ─────────────────────────────────
  async create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    data?: Record<string, unknown>
  ): Promise<Notification> {
    const preferences = await this.getPreferences(userId);

    // Check if user wants this type
    if (!preferences.types[type]) {
      logger.debug('[notifications] Type disabled by user', { userId, type });
      return null!;
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
      expiresAt: type === 'inactivity' ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : undefined,
      tone,
    };

    // Store in Redis
    await this.storeNotification(userId, notification);

    // Update unread count
    await this.incrementUnreadCount(userId);

    // Send real-time if enabled
    if (preferences.enableInApp) {
      await this.sendRealtime(userId, notification);
    }

    // Queue for digest if not realtime
    if (preferences.digestFrequency !== 'realtime') {
      await this.queueForDigest(userId, notification);
    }

    logger.info('[notifications] Created', { userId, type, id: notification.id });

    return notification;
  },

  // ─── Store notification in Redis ─────────────────────────────────────
  async storeNotification(userId: string, notification: Notification): Promise<void> {
    const redis = getRedisClient();
    const key = NOTIF_KEYS.userNotifications(userId);

    await redis.zadd(key, notification.createdAt.getTime(), JSON.stringify(notification));

    // Expire after 30 days
    await redis.expire(key, 30 * 24 * 60 * 60);
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
    const redis = getRedisClient();
    const key = NOTIF_KEYS.userNotifications(userId);

    const results = await redis.zrevrange(key, offset, offset + limit - 1);
    const notifications = results.map((r) => JSON.parse(r) as Notification);

    const total = await redis.zcard(key);
    const unreadCount = await this.getUnreadCount(userId);

    // Filter unread if requested
    const filtered = unreadOnly
      ? notifications.filter((n) => !n.read)
      : notifications;

    return {
      notifications: filtered,
      total,
      unread: unreadCount,
    };
  },

  // ─── Mark as read ────────────────────────────────────────────────────
  async markAsRead(userId: string, notificationId: string): Promise<void> {
    await acknowledgeNotifications(userId, notificationId);
  },

  // ─── Mark all as read ───────────────────────────────────────────────
  async markAllAsRead(userId: string): Promise<void> {
    await acknowledgeNotifications(userId);
  },

  // ─── Unread count helpers ───────────────────────────────────────────
  async incrementUnreadCount(userId: string): Promise<void> {
    const redis = getRedisClient();
    const key = NOTIF_KEYS.unreadCount(userId);
    await redis.incr(key);
  },

  async decrementUnreadCount(userId: string): Promise<void> {
    const redis = getRedisClient();
    const key = NOTIF_KEYS.unreadCount(userId);
    const current = await redis.get(key);
    if (current && parseInt(current, 10) > 0) {
      await redis.decr(key);
    }
  },

  async getUnreadCount(userId: string): Promise<number> {
    const redis = getRedisClient();
    const key = NOTIF_KEYS.unreadCount(userId);
    const count = await redis.get(key);
    return count ? parseInt(count, 10) : 0;
  },

  // ─── Notification preferences ────────────────────────────────────────
  async getPreferences(userId: string): Promise<NotificationPreferences> {
    const redis = getRedisClient();
    const key = NOTIF_KEYS.userPreferences(userId);

    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached);
    }

    // Return defaults if not set
    return DEFAULT_PREFERENCES;
  },

  async updatePreferences(userId: string, updates: Partial<NotificationPreferences>): Promise<void> {
    const redis = getRedisClient();
    const key = NOTIF_KEYS.userPreferences(userId);

    const current = await this.getPreferences(userId);
    const updated = { ...current, ...updates };

    await redis.set(key, JSON.stringify(updated), 'EX', 86400 * 30); // 30 days
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
    const redis = getRedisClient();
    const now = Date.now();

    // This would need to iterate all user notification keys
    // For now, just log the need for this
    logger.info('[notifications] Cleanup scheduled');

    return 0;
  },
};

export default notificationService;
