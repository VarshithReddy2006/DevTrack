import { NotificationRecord } from '../../../db/models/notification.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import { eventBus } from '../../../shared/sse/eventBus.js';
import { getRedisClient, isRedisConfigured } from '../../../shared/redis/client.js';
import { logger } from '../../../shared/logger.js';

export interface ContestStartingSoonEvent {
  eventId: string;
  contestId: string;
  externalId?: string;
  contestName: string;
  platform: 'leetcode' | 'codeforces' | 'codechef' | 'atcoder' | 'other';
  startTime: string;
  endTime?: string;
  durationSeconds?: number;
  url: string;
}

export interface ContestAlertConsumerResult {
  skipped: boolean;
  reason?: string;
  notificationsCreated: number;
  sseBroadcasted: boolean;
}

export async function handleContestStartingSoon(
  event: ContestStartingSoonEvent
): Promise<ContestAlertConsumerResult> {
  const { eventId, contestId, contestName, platform, startTime, url } = event;

  // 1. Inbox deduplication using Redis
  const redis = isRedisConfigured() ? getRedisClient() : null;
  const dedupKey = `devtrack:consumed:contest_alert:${eventId}`;

  if (redis && redis.status === 'ready') {
    const isProcessed = await redis.get(dedupKey);
    if (isProcessed) {
      logger.info(`[contest-alert-consumer] Skipping duplicate event ${eventId}`);
      return { skipped: true, reason: 'duplicate_event', notificationsCreated: 0, sseBroadcasted: false };
    }
  }

  // 2. Find users who have opted into contest alerts
  const optedInSettings = await UserSettings.find({
    'notifications.contestAlerts': true,
  })
    .select('userId platforms')
    .lean();

  let notificationsCreated = 0;

  for (const settings of optedInSettings) {
    const userId = settings.userId?.toString();
    if (!userId) continue;

    // Platform matching: check if user configured this platform or has general preference
    const platformsMap = settings.platforms as Record<string, { username?: string; handle?: string }> | undefined;
    const platformObj = platformsMap?.[platform];
    const isExplicitlyConfigured = platformObj && (platformObj.username || platformObj.handle);
    const hasAnyConfigured = platformsMap && Object.values(platformsMap).some((p) => p && (p.username || p.handle));

    // If user has other platforms connected but not this one, filter out
    if (hasAnyConfigured && !isExplicitlyConfigured) {
      continue;
    }

    const notifId = `notif_contest_${contestId}_${userId}`;
    const result = await NotificationRecord.updateOne(
      { id: notifId },
      {
        $setOnInsert: {
          id: notifId,
          userId,
          type: 'contest_alert',
          title: `Upcoming Contest: ${contestName}`,
          message: `${contestName} on ${platform.toUpperCase()} starts in 30 minutes!`,
          data: {
            contestId,
            platform,
            url,
            startTime,
          },
          read: false,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        },
      },
      { upsert: true }
    );

    if (result.upsertedCount > 0) {
      notificationsCreated++;
    }
  }

  // 3. SSE Broadcast to active connected clients
  try {
    eventBus.publish({
      type: 'contest.starting-soon' as any,
      payload: {
        contestId,
        contestName,
        platform,
        startTime,
        url,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('[contest-alert-consumer] Failed broadcasting SSE contest alert', { err });
  }

  // 4. Record consumption in Redis for 24h
  if (redis && redis.status === 'ready') {
    await redis.set(dedupKey, '1', 'EX', 86400);
  }

  logger.info(`[contest-alert-consumer] Handled contest alert for ${contestName} (${platform}) - ${notificationsCreated} notifications created`);
  return {
    skipped: false,
    notificationsCreated,
    sseBroadcasted: true,
  };
}
