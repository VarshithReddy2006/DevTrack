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

describe('SSE reconnect scheduling and manual retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    post.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    localStorage.setItem('devtrack_access_token', 'jwt');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('exposes when the next attempt happens and clears it once the attempt starts', async () => {
    post.mockRejectedValueOnce(new Error('down'));
    post.mockResolvedValue({ data: { data: { ticket: 't' } } });
    const sse = await loadHook();
    const { useSse } = sse;
    const { act, renderHook } = await import('@testing-library/react');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { createElement } = await import('react');
    const client = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result, unmount } = renderHook(() => useSse(), { wrapper });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.connectionStatus).toBe('reconnecting');
    expect(result.current.nextReconnectAt).toBe(Date.now() + 3_000);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(result.current.nextReconnectAt).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(1);
    unmount();
  });

  it('reconnectNow skips the backoff wait and does not leave a second timer behind', async () => {
    post.mockRejectedValueOnce(new Error('down'));
    post.mockResolvedValue({ data: { data: { ticket: 't' } } });
    const { connectGlobalSse, reconnectNow, disconnectGlobalSse } = await loadHook();

    await connectGlobalSse(vi.fn(), vi.fn());
    expect(FakeEventSource.instances).toHaveLength(0);

    reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.instances).toHaveLength(1);

    // the old 3s timer must have been cancelled, so nothing else connects
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(2);
    disconnectGlobalSse(vi.fn());
  });

  it('reconnectNow twice in a row only opens one stream', async () => {
    post.mockRejectedValueOnce(new Error('down'));
    post.mockResolvedValue({ data: { data: { ticket: 't' } } });
    const { connectGlobalSse, reconnectNow, disconnectGlobalSse } = await loadHook();

    await connectGlobalSse(vi.fn(), vi.fn());
    reconnectNow();
    reconnectNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(2);
    disconnectGlobalSse(vi.fn());
  });

  it('reconnectNow retries after the hook gave up with a fresh failure budget', async () => {
    post.mockRejectedValue(new Error('rate limited'));
    const { connectGlobalSse, reconnectNow, disconnectGlobalSse } = await loadHook();
    const setStatus = vi.fn();

    await connectGlobalSse(setStatus, vi.fn());
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000);
    expect(post).toHaveBeenCalledTimes(5);
    expect(setStatus).toHaveBeenLastCalledWith('disconnected');

    post.mockResolvedValue({ data: { data: { ticket: 'late' } } });
    reconnectNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(post).toHaveBeenCalledTimes(6);
    expect(FakeEventSource.instances).toHaveLength(1);
    disconnectGlobalSse(vi.fn());
  });

  it('reconnectNow does nothing while the stream is open', async () => {
    post.mockResolvedValue({ data: { data: { ticket: 't' } } });
    const { connectGlobalSse, reconnectNow, disconnectGlobalSse } = await loadHook();

    await connectGlobalSse(vi.fn(), vi.fn());
    FakeEventSource.instances[0].onopen?.();
    reconnectNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
    disconnectGlobalSse(vi.fn());
  });
});
