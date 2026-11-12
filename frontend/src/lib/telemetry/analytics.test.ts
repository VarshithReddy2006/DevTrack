import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { telemetry } from './analytics';
import { useUserStore } from '../../store/userStore';

const user = {
  id: 'user-1',
  email: 'user@example.com',
  username: 'user',
  displayName: 'User',
  avatarUrl: null,
  bio: null,
  timezone: 'UTC',
  joinedAt: '2026-01-01T00:00:00Z',
  lastActiveAt: '2026-01-01T00:00:00Z',
  isEmailVerified: true,
  role: 'user' as const,
};
const fetchObservation = vi.fn<typeof fetch>();
const getToken = vi.fn<() => Promise<string | null>>();

function signIn() {
  useUserStore.setState({ user, isAuthenticated: true });
  window.Clerk = { session: { id: 'clerk-session', getToken } };
}

function requests(path: string) {
  return fetchObservation.mock.calls.filter(([url]) => String(url).endsWith(`/observation/${path}`));
}

describe('observation telemetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchObservation);
    fetchObservation.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    getToken.mockReset().mockResolvedValue('clerk-token');
  });

  afterEach(() => {
    telemetry.destroy();
    useUserStore.setState(useUserStore.getInitialState(), true);
    delete window.Clerk;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retains early events until Clerk returns a token and starts the session before sending events', async () => {
    telemetry.track('error_occurred', { message: 'early' });
    expect(fetchObservation).not.toHaveBeenCalled();
    signIn();
    getToken.mockResolvedValueOnce(null);
    telemetry.initialize();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchObservation).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests('session/start')).toHaveLength(1);
    const [url, options] = requests('events')[0];
    expect(fetchObservation.mock.calls[1][0]).toBe(url);
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer clerk-token' });
    expect(JSON.parse(String(options?.body)).events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'error_occurred', userId: 'user-1', properties: { message: 'early' } }),
    ]));
  });

  it('caps the pre-hydration queue and retries after a failed send', async () => {
    for (let index = 0; index < 110; index++) telemetry.track('page_view', { index });
    signIn();
    fetchObservation.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchObservation.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      telemetry.initialize();
      await vi.advanceTimersByTimeAsync(30_000);
      const sends = requests('events');
      expect(sends).toHaveLength(2);
      expect(sends[1][1]?.body).toBe(sends[0][1]?.body);
      const { events } = JSON.parse(String(sends[1][1]?.body));
      expect(events).toHaveLength(100);
      expect(events[0].properties).toEqual({ index: 11 });
    } finally {
      warn.mockRestore();
    }
  });

  it('flushes buffered events and ends a started session with authenticated keepalive on pagehide', async () => {
    signIn();
    telemetry.initialize();
    await vi.advanceTimersByTimeAsync(0);
    telemetry.track('page_view', { page: '/dashboard' });

    window.dispatchEvent(new Event('pagehide'));
    const options = requests('events').at(-1)?.[1];
    expect(options).toMatchObject({ keepalive: true, headers: { Authorization: 'Bearer clerk-token' } });
    expect(JSON.parse(String(options?.body)).events.map((event: { event: string }) => event.event))
      .toEqual(['page_view', 'session_end']);
    expect(requests('session/end')).toHaveLength(1);
    expect(requests('session/end')[0][1]).toMatchObject({ keepalive: true });
    window.dispatchEvent(new Event('pagehide'));
    expect(requests('session/end')).toHaveLength(1);
  });

  it('flushes on visibility loss and keeps the session open for the back-forward cache', async () => {
    signIn();
    telemetry.initialize();
    await vi.advanceTimersByTimeAsync(0);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');

    try {
      telemetry.track('page_view', { page: '/hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(requests('events').at(-1)?.[1]?.keepalive).toBe(true);

      window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
      expect(requests('session/end')).toHaveLength(0);

      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(requests('session/start')).toHaveLength(1);
      expect(getToken).toHaveBeenCalledTimes(2);
    } finally {
      visibility.mockRestore();
    }
  });

  it('never sends an old session queue with a replacement Clerk identity', async () => {
    signIn();
    telemetry.initialize();
    await vi.advanceTimersByTimeAsync(0);
    telemetry.track('page_view', { page: '/old-account' });

    useUserStore.setState({ user: { ...user, id: 'user-2' }, isAuthenticated: true });
    window.Clerk.session = { id: 'replacement-session', getToken };
    window.dispatchEvent(new Event('pagehide'));
    telemetry.initialize();
    await vi.advanceTimersByTimeAsync(0);

    expect(requests('session/end')).toHaveLength(0);
    expect(requests('events').map(([, options]) => String(options?.body)).join()).not.toContain('/old-account');
    expect(requests('session/start')).toHaveLength(2);
  });
});
