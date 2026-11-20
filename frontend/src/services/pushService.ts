// pushService.ts — Web Push subscription endpoints (backend: modules/notifications).
import axiosClient from '../utils/axiosClient';

/** Shape of PushSubscription.toJSON() plus the key it was created with. */
export interface PushSubscriptionPayload {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  vapidPublicKey: string;
}

/** GET /notifications/push-key — the server's current VAPID public key. 503 when push is not configured. */
export async function getPushPublicKey(): Promise<string> {
  const { data } = await axiosClient.get<{ publicKey?: unknown }>('/notifications/push-key');
  if (typeof data.publicKey !== 'string' || !data.publicKey) throw new Error('Invalid push key response');
  return data.publicKey;
}

/** POST /notifications/subscribe — links this browser subscription to the signed-in account. */
export async function registerPushSubscription(subscription: PushSubscriptionPayload): Promise<void> {
  await axiosClient.post('/notifications/subscribe', subscription);
}

/** POST /notifications/unsubscribe — removes this browser's subscription from the account. */
export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await axiosClient.post('/notifications/unsubscribe', { endpoint });
}

/** Push delivery is opt-in on the server, separate from registering a subscription. */
export async function enablePushDelivery(): Promise<void> {
  await axiosClient.patch('/notifications/preferences', { enablePush: true });
}
