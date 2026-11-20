import { beforeEach, describe, expect, it, vi } from 'vitest';
import swSource from '../../../../public/sw.js?raw';

type Listener = (event: Record<string, unknown>) => void;
interface FakeClient { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> }

const ORIGIN = 'https://devtrack.test';

function loadWorker(windowClients: FakeClient[] = []) {
  const listeners: Record<string, Listener> = {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const clients = {
    matchAll: vi.fn().mockResolvedValue(windowClients),
    openWindow: vi.fn().mockResolvedValue(null),
    claim: vi.fn().mockResolvedValue(undefined),
  };
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    registration: { showNotification },
    clients,
    skipWaiting: vi.fn(),
    addEventListener: (type: string, listener: Listener) => { listeners[type] = listener; },
  };
  new Function('self', 'clients', swSource)(self, clients);
  return { listeners, showNotification, clients };
}

function client(url: string): FakeClient {
  const result: FakeClient = { url, focus: vi.fn(), navigate: vi.fn().mockResolvedValue(undefined) };
  result.focus.mockResolvedValue(result);
  return result;
}

async function dispatch(listener: Listener, event: Record<string, unknown>) {
  let pending: Promise<unknown> = Promise.resolve();
  listener({ ...event, waitUntil: (promise: Promise<unknown>) => { pending = promise; } });
  await pending;
}

function clickEvent(url?: string) {
  return { notification: { close: vi.fn(), data: url === undefined ? {} : { url } } };
}

describe('service worker', () => {
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));

  it('shows the contest payload the backend sends', async () => {
    const { listeners, showNotification } = loadWorker();
    await dispatch(listeners.push, { data: { json: () => ({
      title: 'Upcoming Contest: Weekly 420',
      body: 'Weekly 420 on LEETCODE starts in 30 minutes!',
      icon: 'https://leetcode.com/favicon.ico',
      url: 'https://leetcode.com/contest/weekly-420',
      contestId: 'c1',
      tag: 'contest-alert-c1',
      actions: [{ action: 'open-contest', title: 'View contest' }],
    }) } });
    expect(showNotification).toHaveBeenCalledWith('Upcoming Contest: Weekly 420', expect.objectContaining({
      body: 'Weekly 420 on LEETCODE starts in 30 minutes!',
      icon: 'https://leetcode.com/favicon.ico',
      tag: 'contest-alert-c1',
      data: { url: 'https://leetcode.com/contest/weekly-420', contestId: 'c1' },
    }));
  });

  it('accepts the URL nested under data and falls back to the contests page', async () => {
    const { listeners, showNotification } = loadWorker();
    await dispatch(listeners.push, { data: { json: () => ({ title: 'A', data: { url: '/contests?id=1' } }) } });
    await dispatch(listeners.push, { data: { json: () => ({ title: 'B' }) } });
    expect(showNotification.mock.calls[0][1].data.url).toBe('/contests?id=1');
    expect(showNotification.mock.calls[1][1].data.url).toBe('/contests');
  });

  it('ignores payloads it cannot parse', async () => {
    const { listeners, showNotification } = loadWorker();
    await dispatch(listeners.push, { data: { json: () => { throw new SyntaxError('bad'); } } });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('focuses a tab that is already on the target page', async () => {
    const onContests = client(`${ORIGIN}/contests`);
    const { listeners, clients } = loadWorker([client(`${ORIGIN}/dashboard`), onContests]);
    const event = clickEvent('/contests');
    await dispatch(listeners.notificationclick, event);
    expect(event.notification.close).toHaveBeenCalled();
    expect(onContests.focus).toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it('reuses an open DevTrack tab for in-app pages', async () => {
    const dashboard = client(`${ORIGIN}/dashboard`);
    const { listeners, clients } = loadWorker([dashboard]);
    await dispatch(listeners.notificationclick, clickEvent());
    expect(dashboard.focus).toHaveBeenCalled();
    expect(dashboard.navigate).toHaveBeenCalledWith(`${ORIGIN}/contests`);
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens contest sites in a new window', async () => {
    const dashboard = client(`${ORIGIN}/dashboard`);
    const { listeners, clients } = loadWorker([dashboard]);
    await dispatch(listeners.notificationclick, clickEvent('https://codeforces.com/contest/2000'));
    expect(clients.openWindow).toHaveBeenCalledWith('https://codeforces.com/contest/2000');
    expect(dashboard.navigate).not.toHaveBeenCalled();
  });
});
