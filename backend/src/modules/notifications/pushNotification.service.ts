import { createECDH } from 'node:crypto';
import * as webPush from 'web-push';
import { PushSubscriptionRecord } from '../../db/models/pushSubscription.model.js';
import { NotificationPreference } from '../../db/models/notification.model.js';
import { logger } from '../../shared/logger.js';
import { isPushEndpoint, pushSubscriptionSchema, type PushSubscriptionInput } from './pushNotification.validation.js';
import type { ContestStartingSoonEvent } from './consumers/contestStartingSoon.consumer.js';

function keyPair(publicKey?: string, privateKey?: string) {
  if (!publicKey || !privateKey) return null;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (ecdh.getPublicKey().toString('base64url') !== publicKey) return null;
    return { publicKey, privateKey };
  } catch {
    return null;
  }
}

function getConfiguration() {
  const active = keyPair(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  const subject = process.env.VAPID_SUBJECT;
  if (!active || !subject) return null;
  try {
    const url = new URL(subject);
    if (!['https:', 'mailto:'].includes(url.protocol)) return null;
    return {
      subject, active,
      previous: keyPair(process.env.VAPID_PREVIOUS_PUBLIC_KEY, process.env.VAPID_PREVIOUS_PRIVATE_KEY),
    };
  } catch {
    return null;
  }
}

export function getPushPublicKey(): string | null {
  return getConfiguration()?.active.publicKey ?? null;
}

export async function subscribePush(userId: string, input: PushSubscriptionInput): Promise<'saved' | 'unavailable' | 'conflict'> {
  const subscription = pushSubscriptionSchema.parse(input);
  const config = getConfiguration();
  if (!config) return 'unavailable';
  if (subscription.vapidPublicKey && subscription.vapidPublicKey !== config.active.publicKey) return 'conflict';
  await PushSubscriptionRecord.init();
  try {
    // A globally unique endpoint may only be updated by its existing owner.
    await PushSubscriptionRecord.updateOne(
      { userId, endpoint: subscription.endpoint },
      { $set: { keys: subscription.keys, vapidPublicKey: config.active.publicKey } },
      { upsert: true, runValidators: true },
    );
    return 'saved';
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return 'conflict';
    throw error;
  }
}

export async function unsubscribePush(userId: string, endpoint: string): Promise<void> {
  await PushSubscriptionRecord.deleteOne({ userId, endpoint });
}

export function buildContestPushPayload(event: ContestStartingSoonEvent) {
  const minutesRemaining = Math.max(0, Math.ceil((Date.parse(event.startTime) - Date.now()) / 60_000));
  let url = '/contests';
  try {
    const target = new URL(event.url);
    if (target.protocol === 'https:' && !target.username && !target.password) url = target.href;
  } catch { /* Keep the local contest page fallback. */ }
  return {
    title: `Upcoming Contest: ${event.contestName.slice(0, 160)}`,
    body: `${event.contestName.slice(0, 160)} on ${event.platform.toUpperCase()} starts in ${minutesRemaining} minutes!`,
    contestId: event.contestId,
    contestName: event.contestName.slice(0, 160),
    platform: event.platform,
    icon: {
      leetcode: 'https://leetcode.com/favicon.ico',
      codeforces: 'https://codeforces.com/favicon.ico',
      codechef: 'https://www.codechef.com/favicon.ico',
      atcoder: 'https://atcoder.jp/favicon.ico',
      other: '/favicon.svg',
    }[event.platform],
    startTime: event.startTime,
    minutesRemaining,
    url,
    tag: `contest-alert-${event.contestId}`,
    actions: [{ action: 'open-contest', title: 'View contest' }],
  };
}

// Called only for users already selected by the contest opt-in/platform filter.
// Delivery is best effort, so one provider failure cannot stop in-app alerts.
export async function sendContestPush(userId: string, event: ContestStartingSoonEvent): Promise<void> {
  const config = getConfiguration();
  if (!config) return;
  const preference = await NotificationPreference.findOne({ userId }).lean();
  if (preference?.preferences?.enablePush !== true) return;
  const payload = JSON.stringify(buildContestPushPayload(event));
  const ttl = Math.min(1800, Math.ceil((Date.parse(event.startTime) - Date.now()) / 1000));
  if (!Number.isFinite(ttl) || ttl <= 0) return;

  const subscriptions = PushSubscriptionRecord.find({ userId }).cursor();
  for await (const subscription of subscriptions) {
    const pair = [config.active, config.previous].find((key) => key?.publicKey === subscription.vapidPublicKey);
    if (!pair || !subscription.keys || !isPushEndpoint(subscription.endpoint)) continue;
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.keys.p256dh!, auth: subscription.keys.auth! },
      }, payload, {
        vapidDetails: { subject: config.subject, ...pair },
        contentEncoding: 'aes128gcm', TTL: ttl, timeout: 10_000, urgency: 'high',
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Do not delete credentials refreshed while this request was in flight.
        await PushSubscriptionRecord.deleteOne({
          _id: subscription._id, userId,
          'keys.p256dh': subscription.keys.p256dh, 'keys.auth': subscription.keys.auth,
          vapidPublicKey: subscription.vapidPublicKey,
        });
      } else {
        // Provider errors can contain endpoint/auth credentials; log only status.
        logger.warn('[web-push] Contest delivery failed', { userId, statusCode });
      }
    }
  }
}
