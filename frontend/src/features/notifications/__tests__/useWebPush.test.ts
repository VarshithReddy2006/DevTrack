import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebPush } from '../hooks/useWebPush';
import { sameApplicationServerKey, urlBase64ToUint8Array } from '../webPush';

const pushService = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(),
  registerPushSubscription: vi.fn(),
  unregisterPushSubscription: vi.fn(),
  enablePushDelivery: vi.fn(),
}));
vi.mock('../../../services/pushService', () => pushService);

const PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
const OLD_KEY = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';

function makeSubscription(key: string, endpoint = ENDPOINT) {
  return {
    endpoint,
    options: { applicationServerKey: urlBase64ToUint8Array(key).buffer },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'p256dh-key', auth: 'auth-secret' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

type FakeSubscription = ReturnType<typeof makeSubscription>;

function installBrowser({ permission = 'default' as NotificationPermission, existing = null as FakeSubscription | null } = {}) {
  const created = makeSubscription(PUBLIC_KEY, 'https://fcm.googleapis.com/fcm/send/device-2');
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existing),
    subscribe: vi.fn().mockResolvedValue(created),
  };
  const registration = { pushManager };
  const serviceWorker = {
    register: vi.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration),
    getRegistration: vi.fn().mockResolvedValue(existing ? registration : undefined),
  };
  Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
  vi.stubGlobal('PushManager', function PushManager() { /* feature detection only */ });
  const notification = { permission, requestPermission: vi.fn().mockResolvedValue('granted') };
  vi.stubGlobal('Notification', notification);
  return { pushManager, serviceWorker, notification, created };
}

beforeEach(() => {
  Object.values(pushService).forEach((mock) => mock.mockReset());
  pushService.getPushPublicKey.mockResolvedValue(PUBLIC_KEY);
  pushService.registerPushSubscription.mockResolvedValue(undefined);
  pushService.unregisterPushSubscription.mockResolvedValue(undefined);
  pushService.enablePushDelivery.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe('web push helpers', () => {
  it('converts a base64url VAPID key into its 65 raw bytes', () => {
    const bytes = urlBase64ToUint8Array(PUBLIC_KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });

  it('compares subscription keys byte by byte', () => {
    const key = urlBase64ToUint8Array(PUBLIC_KEY);
    expect(sameApplicationServerKey(urlBase64ToUint8Array(PUBLIC_KEY).buffer, key)).toBe(true);
    expect(sameApplicationServerKey(urlBase64ToUint8Array(OLD_KEY).buffer, key)).toBe(false);
    expect(sameApplicationServerKey(null, key)).toBe(false);
  });
});

describe('useWebPush', () => {
  it('reports unsupported browsers without touching any API', () => {
    const { result } = renderHook(() => useWebPush());
    expect(result.current.status).toBe('unsupported');
    expect(result.current.checking).toBe(false);
  });

  it('starts as denied when notifications are blocked', () => {
    installBrowser({ permission: 'denied' });
    const { result } = renderHook(() => useWebPush());
    expect(result.current.status).toBe('denied');
  });

  it('recognises an existing subscription on load', async () => {
    installBrowser({ permission: 'granted', existing: makeSubscription(PUBLIC_KEY) });
    const { result } = renderHook(() => useWebPush());
    expect(result.current.checking).toBe(true);
    await waitFor(() => expect(result.current.checking).toBe(false));
    expect(result.current.status).toBe('subscribed');
  });

  it('asks permission, subscribes with the server key and syncs the endpoint', async () => {
    const { pushManager, serviceWorker } = installBrowser();
    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.checking).toBe(false));

    let ok = false;
    await act(async () => { ok = await result.current.subscribe(); });

    expect(ok).toBe(true);
    expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    const options = pushManager.subscribe.mock.calls[0][0];
    expect(options.userVisibleOnly).toBe(true);
    expect(Array.from(options.applicationServerKey)).toEqual(Array.from(urlBase64ToUint8Array(PUBLIC_KEY)));
    expect(pushService.registerPushSubscription).toHaveBeenCalledWith({
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-2',
      expirationTime: null,
      keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
      vapidPublicKey: PUBLIC_KEY,
    });
    expect(pushService.enablePushDelivery).toHaveBeenCalled();
    expect(result.current.status).toBe('subscribed');
    expect(result.current.error).toBeNull();
  });

  it('stops quietly when the user blocks the permission prompt', async () => {
    const { notification, pushManager } = installBrowser();
    notification.requestPermission.mockResolvedValue('denied');
    const { result } = renderHook(() => useWebPush());
    await act(async () => { await result.current.subscribe(); });
    expect(result.current.status).toBe('denied');
    expect(result.current.error).toBeNull();
    expect(pushService.getPushPublicKey).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('replaces a subscription made with an old server key', async () => {
    const stale = makeSubscription(OLD_KEY);
    const { pushManager } = installBrowser({ existing: stale });
    const { result } = renderHook(() => useWebPush());
    await act(async () => { await result.current.subscribe(); });
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('subscribed');
  });

  it('reuses a current subscription instead of creating another', async () => {
    const current = makeSubscription(PUBLIC_KEY);
    const { pushManager } = installBrowser({ existing: current });
    const { result } = renderHook(() => useWebPush());
    await act(async () => { await result.current.subscribe(); });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushService.registerPushSubscription).toHaveBeenCalledWith(expect.objectContaining({ endpoint: ENDPOINT }));
  });

  it('explains when push is not configured on the server', async () => {
    const { pushManager } = installBrowser();
    pushService.getPushPublicKey.mockRejectedValue({ statusCode: 503 });
    const { result } = renderHook(() => useWebPush());
    await act(async () => { await result.current.subscribe(); });
    expect(result.current.status).toBe('prompt');
    expect(result.current.error).toMatch(/aren't available/);
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('removes the new browser subscription if the server rejects it', async () => {
    const { created } = installBrowser();
    pushService.registerPushSubscription.mockRejectedValue({ statusCode: 409 });
    const { result } = renderHook(() => useWebPush());
    await act(async () => { await result.current.subscribe(); });
    expect(created.unsubscribe).toHaveBeenCalled();
    expect(pushService.enablePushDelivery).not.toHaveBeenCalled();
    expect(result.current.status).toBe('prompt');
    expect(result.current.error).toMatch(/another DevTrack account/);
  });

  it('unsubscribes on the server, then in the browser', async () => {
    const current = makeSubscription(PUBLIC_KEY);
    installBrowser({ permission: 'granted', existing: current });
    const order: string[] = [];
    pushService.unregisterPushSubscription.mockImplementation(async () => { order.push('server'); });
    current.unsubscribe.mockImplementation(async () => { order.push('browser'); return true; });
    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.status).toBe('subscribed'));
    await act(async () => { await result.current.unsubscribe(); });
    expect(pushService.unregisterPushSubscription).toHaveBeenCalledWith(ENDPOINT);
    expect(order).toEqual(['server', 'browser']);
    expect(result.current.status).toBe('prompt');
  });

  it('keeps the subscription when the server unsubscribe fails', async () => {
    const current = makeSubscription(PUBLIC_KEY);
    installBrowser({ permission: 'granted', existing: current });
    pushService.unregisterPushSubscription.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useWebPush());
    await waitFor(() => expect(result.current.status).toBe('subscribed'));
    await act(async () => { await result.current.unsubscribe(); });
    expect(current.unsubscribe).not.toHaveBeenCalled();
    expect(result.current.status).toBe('subscribed');
    expect(result.current.error).toMatch(/couldn't turn off/);
  });
});
