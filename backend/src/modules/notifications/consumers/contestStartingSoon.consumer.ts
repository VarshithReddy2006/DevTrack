import { NotificationRecord } from '../../../db/models/notification.model.js';
import { ProcessedEvent } from '../../../db/models/processedEvent.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import { eventBus } from '../../../shared/sse/eventBus.js';
import { getRedisClient, isRedisConfigured } from '../../../shared/redis/client.js';
import { logger } from '../../../shared/logger.js';
import { sendContestPush } from '../pushNotification.service.js';

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

export const CONTEST_ALERT_CONSUMER = 'notifications.contest-alert';
const CONTEST_ALERT_EVENT_TYPE = 'contest.starting-soon';
// How long a finished event stays deduplicated.
const DEDUP_TTL_SECONDS = 24 * 60 * 60;
// A claim starts as a short lease. If the worker dies mid-run the lease expires and a
// replay can resume; users already notified are skipped by the per-user notification id.
const CLAIM_LEASE_SECONDS = 10 * 60;
export const CONTEST_ALERT_USER_BATCH_SIZE = 100;

type EventClaim = { store: 'redis'; redis: ReturnType<typeof getRedisClient> } | { store: 'mongo' };

type OptedInSettings = {
  userId?: { toString(): string } | null;
  platforms?: unknown;
  notifications?: { pushNotifications?: boolean } | null;
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function isDuplicateKeyError(err: unknown): boolean {
  const message = (err as Error)?.message || '';
  return (err as { code?: number })?.code === 11000 || message.includes('E11000') || message.includes('duplicate key');
}

/**
 * Atomically claims the event before any alert goes out. Redis SET NX EX is used when it
 * is ready; when Redis is unconfigured, not ready or erroring, the unique
 * (consumer, eventId) index on ProcessedEvent does the same job.
 */
async function claimEvent(eventId: string, dedupKey: string): Promise<EventClaim | null> {
  const redis = isRedisConfigured() ? getRedisClient() : null;

  if (redis && redis.status === 'ready') {
    try {
      const acquired = await redis.set(dedupKey, 'processing', 'EX', CLAIM_LEASE_SECONDS, 'NX');
      return acquired ? { store: 'redis', redis } : null;
    } catch (err) {
      logger.warn('[contest-alert-consumer] Redis claim failed, using ProcessedEvent fallback', {
        eventId,
        error: errorMessage(err),
      });
    }
  } else if (redis) {
    logger.warn('[contest-alert-consumer] Redis not ready, using ProcessedEvent fallback', {
      eventId,
      redisStatus: redis.status,
    });
  }

  try {
    await ProcessedEvent.create({
      consumer: CONTEST_ALERT_CONSUMER,
      eventId,
      eventType: CONTEST_ALERT_EVENT_TYPE,
      processedAt: new Date(),
      ttlExpiresAt: new Date(Date.now() + CLAIM_LEASE_SECONDS * 1000),
      result: { success: false, details: 'processing' },
    });
    return { store: 'mongo' };
  } catch (err) {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  }
}

async function markEventDone(claim: EventClaim, eventId: string, dedupKey: string): Promise<void> {
  try {
    if (claim.store === 'redis') {
      await claim.redis.set(dedupKey, 'done', 'EX', DEDUP_TTL_SECONDS);
    } else {
      await ProcessedEvent.updateOne(
        { consumer: CONTEST_ALERT_CONSUMER, eventId },
        {
          $set: {
            processedAt: new Date(),
            ttlExpiresAt: new Date(Date.now() + DEDUP_TTL_SECONDS * 1000),
            result: { success: true },
          },
        }
      );
    }
  } catch (err) {
    // Alerts already went out. If the lease expires and the event is replayed, the
    // per-user notification upsert still stops a second alert.
    logger.warn('[contest-alert-consumer] Failed to mark contest alert as processed', {
      eventId,
      store: claim.store,
      error: errorMessage(err),
    });
  }
}

// Same idea as executeInboxNonTransactional: drop the claim on failure so a retry is not
// skipped as a duplicate.
async function releaseEvent(claim: EventClaim, eventId: string, dedupKey: string): Promise<void> {
  try {
    if (claim.store === 'redis') {
      await claim.redis.del(dedupKey);
    } else {
      await ProcessedEvent.deleteOne({ consumer: CONTEST_ALERT_CONSUMER, eventId });
    }
  } catch (err) {
    logger.error('[contest-alert-consumer] Failed to release contest alert claim', err, {
      eventId,
      store: claim.store,
    });
  }
}

async function notifyUser(settings: OptedInSettings, event: ContestStartingSoonEvent): Promise<boolean> {
  const { contestId, contestName, platform, startTime, url } = event;
  const userId = settings.userId?.toString();
  if (!userId) return false;

  // Platform matching: check if user configured this platform or has general preference
  const platformsMap = settings.platforms as Record<string, { username?: string; handle?: string }> | undefined;
  const platformObj = platformsMap?.[platform];
  const isExplicitlyConfigured = platformObj && (platformObj.username || platformObj.handle);
  const hasAnyConfigured = platformsMap && Object.values(platformsMap).some((p) => p && (p.username || p.handle));

  // If user has other platforms connected but not this one, filter out
  if (hasAnyConfigured && !isExplicitlyConfigured) {
    return false;
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

  if (result.upsertedCount === 0) return false;

  if (settings.notifications?.pushNotifications !== false) {
    try {
      await sendContestPush(userId, event);
    } catch {
      // Do not expose provider credentials or stop alerts for other users.
      logger.warn('[contest-alert-consumer] Web Push delivery failed', { userId, contestId });
    }
  }
  return true;
}

// Streams opted-in users from a cursor so only one batch is held in memory at a time.
async function notifyOptedInUsers(event: ContestStartingSoonEvent): Promise<number> {
  const cursor = UserSettings.find({
    'notifications.contestAlerts': true,
  })
    .select('userId platforms notifications.pushNotifications')
    .lean()
    .cursor({ batchSize: CONTEST_ALERT_USER_BATCH_SIZE });

  let notificationsCreated = 0;
  try {
    for await (const settings of cursor) {
      if (await notifyUser(settings, event)) notificationsCreated++;
    }
  } finally {
    await cursor.close();
  }
  return notificationsCreated;
}

export async function handleContestStartingSoon(
  event: ContestStartingSoonEvent
): Promise<ContestAlertConsumerResult> {
  const { eventId, contestId, contestName, platform, startTime, url } = event;
  const dedupKey = `devtrack:consumed:contest_alert:${eventId}`;

  // 1. Claim the event atomically (Redis SET NX EX, ProcessedEvent as fallback)
  const claim = await claimEvent(eventId, dedupKey);
  if (!claim) {
    logger.info(`[contest-alert-consumer] Skipping duplicate event ${eventId}`);
    return { skipped: true, reason: 'duplicate_event', notificationsCreated: 0, sseBroadcasted: false };
  }

  // 2. Notify opted-in users
  let notificationsCreated: number;
  try {
    notificationsCreated = await notifyOptedInUsers(event);
  } catch (err) {
    await releaseEvent(claim, eventId, dedupKey);
    throw err;
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

  // 4. Keep the event deduplicated for 24h
  await markEventDone(claim, eventId, dedupKey);

  logger.info(`[contest-alert-consumer] Handled contest alert for ${contestName} (${platform}) - ${notificationsCreated} notifications created`);
  return {
    skipped: false,
    notificationsCreated,
    sseBroadcasted: true,
  };
}
