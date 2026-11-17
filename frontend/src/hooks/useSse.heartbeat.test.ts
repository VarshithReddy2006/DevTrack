import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('../utils/axiosClient', () => ({ default: { post } }));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<() => void>>();
  close = vi.fn();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  /** What a browser does when the server writes `event: <type>\ndata: {}\n\n`. */
  dispatch(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

const dataEvent = (id: string) =>
  ({
    data: JSON.stringify({
      id,
      type: 'xp_updated',
      sequence: 1,
      timestamp: new Date().toISOString(),
      userId: 'u1',
      payload: { n: id },
    }),
    lastEventId: id,
  }) as unknown as MessageEvent;

async function loadHook() {
  vi.resetModules();
  const sse = await import('./useSse');
  const { useUserStore } = await import('../store/userStore');
  useUserStore.setState({ isAuthenticated: true });
  return sse;
}

describe('SSE idle watchdog and the server heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    post.mockReset();
    post.mockResolvedValue({ data: { data: { ticket: 't' } } });
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    localStorage.setItem('devtrack_access_token', 'jwt');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('keeps an idle stream open while the server sends heartbeat events', async () => {
    const { connectGlobalSse, disconnectGlobalSse } = await loadHook();
    await connectGlobalSse(vi.fn(), vi.fn());
    const es = FakeEventSource.instances[0];
    es.onopen!();
    es.onmessage!(dataEvent('1-0')); // the server sends runtime_state_full right on connect

    // 25s is the server heartbeat period; nothing else arrives for 5 minutes.
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      es.dispatch('heartbeat');
    }

    expect(es.close).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
    disconnectGlobalSse(vi.fn());
  });

  it('does not reconnect-loop against a server that only sends comment keepalives', async () => {
    // An older server writes `: heartbeat` lines. Browsers never surface those, so the client
    // sees one data event and then silence even though the connection is healthy.
    const { connectGlobalSse, disconnectGlobalSse } = await loadHook();
    await connectGlobalSse(vi.fn(), vi.fn());
    const es = FakeEventSource.instances[0];
    es.onopen!();
    es.onmessage!(dataEvent('1-0'));

    await vi.advanceTimersByTimeAsync(300_000);

    expect(es.close).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
    disconnectGlobalSse(vi.fn());
  });

  it('still tears down a stream whose heartbeats stop arriving', async () => {
    const { connectGlobalSse, disconnectGlobalSse } = await loadHook();
    const setStatus = vi.fn();
    await connectGlobalSse(setStatus, vi.fn());
    const es = FakeEventSource.instances[0];
    es.onopen!();
    es.dispatch('heartbeat');

    // half-open connection: no heartbeat for well over 2 x 30s
    await vi.advanceTimersByTimeAsync(100_000);

    expect(es.close).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    disconnectGlobalSse(vi.fn());
  });

  it('a reconnected stream is judged on its own heartbeats, not the previous stream timestamp', async () => {
    const { connectGlobalSse, disconnectGlobalSse } = await loadHook();
    await connectGlobalSse(vi.fn(), vi.fn());
    const first = FakeEventSource.instances[0];
    first.onopen!();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      first.onmessage!(dataEvent(`${i}-0`));
      first.dispatch('heartbeat');
    }

    first.onerror!(); // clean drop, the hook reconnects after the backoff
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1];
    second.onopen!();
    second.dispatch('heartbeat');

    // the old stream's last data event is 3s+ old and would be >60s stale after a minute; the
    // new stream must only be judged on what it sent itself
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      second.dispatch('heartbeat');
    }

    expect(second.close).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
    disconnectGlobalSse(vi.fn());
  });
});
