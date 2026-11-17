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
  addEventListener = vi.fn();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
}

const openStreams = () => FakeEventSource.instances.filter((es) => es.close.mock.calls.length === 0);

/** Handshake that answers after `ms`, like a real request would. */
function slowHandshake(ms = 50) {
  let n = 0;
  post.mockImplementation(
    () =>
      new Promise((resolve) => {
        const ticket = `ticket-${++n}`;
        setTimeout(() => resolve({ data: { data: { ticket } } }), ms);
      })
  );
}

/** Let every pending connect get past the token lookup so its handshake POST is really in flight. */
async function untilHandshakeSent(calls = 1) {
  for (let i = 0; i < 20 && post.mock.calls.length < calls; i++) await vi.advanceTimersByTimeAsync(0);
  expect(post).toHaveBeenCalledTimes(calls);
}

async function loadHook(authenticated = true) {
  vi.resetModules();
  const sse = await import('./useSse');
  await import('../utils/axiosClient'); // warm the module cache so the lazy import in connect is quick
  const { useUserStore } = await import('../store/userStore');
  useUserStore.setState({ isAuthenticated: authenticated });
  return { sse, useUserStore };
}

describe('connectGlobalSse is re-entrant safe and cancellable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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

  it('two overlapping connects share one handshake and open one stream', async () => {
    slowHandshake();
    const { sse } = await loadHook();

    const both = Promise.all([sse.connectGlobalSse(vi.fn(), vi.fn()), sse.connectGlobalSse(vi.fn(), vi.fn())]);
    await untilHandshakeSent();
    await vi.advanceTimersByTimeAsync(50);
    await both;

    expect(post).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    sse.disconnectGlobalSse(vi.fn());
    expect(openStreams()).toHaveLength(0);
  });

  it('disconnect during the ticket request means no stream is opened afterwards', async () => {
    slowHandshake();
    const { sse } = await loadHook();
    const setStatus = vi.fn();

    const pending = sse.connectGlobalSse(setStatus, vi.fn());
    await untilHandshakeSent();
    sse.disconnectGlobalSse(setStatus); // logout, or the last hook unmounting, while the POST is in flight
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(FakeEventSource.instances).toHaveLength(0);
    expect(setStatus).toHaveBeenLastCalledWith('disconnected');
  });

  it('disconnect before the handshake request is even sent also cancels the connect', async () => {
    slowHandshake();
    const { sse } = await loadHook();

    const pending = sse.connectGlobalSse(vi.fn(), vi.fn());
    sse.disconnectGlobalSse(vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(post).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('a failed ticket request that was cancelled by a disconnect does not schedule a reconnect', async () => {
    post.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('down')), 50))
    );
    const { sse } = await loadHook();

    const pending = sse.connectGlobalSse(vi.fn(), vi.fn());
    await untilHandshakeSent();
    sse.disconnectGlobalSse(vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(post).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('connect, disconnect, connect again: only the newest attempt opens a stream', async () => {
    slowHandshake();
    const { sse } = await loadHook();

    const first = sse.connectGlobalSse(vi.fn(), vi.fn());
    await untilHandshakeSent();
    sse.disconnectGlobalSse(vi.fn());
    const second = sse.connectGlobalSse(vi.fn(), vi.fn());
    await untilHandshakeSent(2);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);

    expect(post).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toContain('ticket=ticket-2');

    sse.disconnectGlobalSse(vi.fn());
    expect(openStreams()).toHaveLength(0);
  });

  it('after a finished connect the next connect is a no-op while the stream is open', async () => {
    slowHandshake();
    const { sse } = await loadHook();

    const first = sse.connectGlobalSse(vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    await first;
    await sse.connectGlobalSse(vi.fn(), vi.fn());

    expect(post).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    sse.disconnectGlobalSse(vi.fn());
  });
});
