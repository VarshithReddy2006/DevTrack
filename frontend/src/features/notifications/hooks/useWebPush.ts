import { useCallback, useEffect, useState } from 'react';
import {
  enablePushDelivery,
  getPushPublicKey,
  registerPushSubscription,
  unregisterPushSubscription,
  type PushSubscriptionPayload,
} from '../../../services/pushService';
import { isPushSupported, sameApplicationServerKey, urlBase64ToUint8Array } from '../webPush';

export type WebPushStatus = 'unsupported' | 'prompt' | 'subscribed' | 'denied';

const SERVICE_WORKER_URL = '/sw.js';

function permissionStatus(): WebPushStatus {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission === 'denied' ? 'denied' : 'prompt';
}

function enableErrorMessage(cause: unknown): string {
  const statusCode = (cause as { statusCode?: number } | null)?.statusCode;
  if (statusCode === 503) return "Contest alerts aren't available on the server right now.";
  if (statusCode === 409) return 'This browser is linked to another DevTrack account or an old key. Try again in a moment.';
  return "We couldn't turn on contest alerts. Try again.";
}

/**
 * Browser permission, push subscription and server registration for contest alerts.
 * Never throws: failures end in a status plus an `error` message for the UI.
 */
export function useWebPush() {
  const [status, setStatus] = useState<WebPushStatus>(permissionStatus);
  // While true we are still looking for an existing subscription, so the UI should wait.
  const [checking, setChecking] = useState(() => permissionStatus() === 'prompt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (permissionStatus() !== 'prompt') return;
    let active = true;
    navigator.serviceWorker.getRegistration('/')
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then((subscription) => {
        if (active && subscription && Notification.permission === 'granted') setStatus('subscribed');
      })
      .catch(() => { /* No registration yet: stay on prompt. */ })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, []);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!isPushSupported()) {
      setStatus('unsupported');
      return false;
    }
    setBusy(true);
    setError(null);
    let subscription: PushSubscription | null = null;
    let createdHere = false;
    let registeredOnServer = false;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'prompt');
        return false;
      }
      const publicKey = await getPushPublicKey();
      const applicationServerKey = urlBase64ToUint8Array(publicKey);
      await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
      const registration = await navigator.serviceWorker.ready;

      subscription = await registration.pushManager.getSubscription();
      // A subscription made with a rotated-out key would be rejected by the server.
      if (subscription && !sameApplicationServerKey(subscription.options?.applicationServerKey, applicationServerKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        createdHere = true;
      }

      const json = subscription.toJSON() as Omit<PushSubscriptionPayload, 'vapidPublicKey'>;
      await registerPushSubscription({ ...json, vapidPublicKey: publicKey });
      registeredOnServer = true;
      await enablePushDelivery();
      setStatus('subscribed');
      return true;
    } catch (cause) {
      // Don't leave a browser subscription the server never heard about.
      if (createdHere && !registeredOnServer && subscription) await subscription.unsubscribe().catch(() => false);
      setError(enableErrorMessage(cause));
      setStatus(registeredOnServer ? 'subscribed' : permissionStatus());
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async (): Promise<boolean> => {
    if (!isPushSupported()) return false;
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        // Server first, so a failure leaves both sides still in step.
        await unregisterPushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setStatus(permissionStatus());
      return true;
    } catch {
      setError("We couldn't turn off contest alerts. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, checking, busy, error, subscribe, unsubscribe };
}
