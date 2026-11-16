import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('../utils/axiosClient', () => ({ default: { post } }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
}

async function loadHook() {
  vi.resetModules();
  const sse = await import('./useSse');
  const { useUserStore } = await import('../store/userStore');
  useUserStore.setState({ isAuthenticated: true });
  return sse;
}

describe('global SSE handshake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    localStorage.setItem('devtrack_access_token', 'jwt-that-must-not-leak');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('opens the stream with the ticket and never puts the access token in the URL', async () => {
    post.mockResolvedValue({ data: { data: { ticket: 'ticket-1' } } });
    const { connectGlobalSse, disconnectGlobalSse } = await loadHook();

    await connectGlobalSse(vi.fn(), vi.fn());

    expect(post).toHaveBeenCalledWith('/auth/sse-handshake');
    expect(FakeEventSource.instances).toHaveLength(1);
    const url = new URL(FakeEventSource.instances[0].url, 'http://localhost');
    expect(url.searchParams.get('ticket')).toBe('ticket-1');
    expect(url.searchParams.has('token')).toBe(false);
    expect(FakeEventSource.instances[0].url).not.toContain('jwt-that-must-not-leak');
    disconnectGlobalSse(vi.fn());
  });

  it('does not fall back to the JWT when the ticket request fails, it retries with a fresh ticket', async () => {
    post.mockRejectedValueOnce(new Error('network down'));
    post.mockResolvedValue({ data: { data: { ticket: 'ticket-2' } } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { connectGlobalSse, disconnectGlobalSse } = await loadHook();
    const setStatus = vi.fn();

    await connectGlobalSse(setStatus, vi.fn());

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(setStatus).toHaveBeenLastCalledWith('reconnecting');

    await vi.advanceTimersByTimeAsync(3_000);

    expect(post).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1);
    const url = new URL(FakeEventSource.instances[0].url, 'http://localhost');
    expect(url.searchParams.get('ticket')).toBe('ticket-2');
    expect(url.searchParams.has('token')).toBe(false);
    disconnectGlobalSse(vi.fn());
  });

  it('marks the connection degraded after repeated ticket failures instead of retrying forever', async () => {
    post.mockRejectedValue(new Error('rate limited'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { connectGlobalSse, disconnectGlobalSse } = await loadHook();
    const setStatus = vi.fn();
    const setDegraded = vi.fn();

    await connectGlobalSse(setStatus, setDegraded);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(post).toHaveBeenCalledTimes(5);
    expect(setStatus).toHaveBeenLastCalledWith('disconnected');
    expect(setDegraded).toHaveBeenCalledWith(true);
    disconnectGlobalSse(vi.fn());
  });
});
