import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';

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

const envelope = (id: string, type: string) =>
  ({
    data: JSON.stringify({
      id,
      type,
      sequence: 1,
      timestamp: new Date().toISOString(),
      userId: 'u1',
      payload: { n: id },
    }),
    lastEventId: id,
  }) as unknown as MessageEvent;

async function setup() {
  vi.resetModules();
  const sse = await import('./useSse');
  const { useUserStore } = await import('../store/userStore');
  const rtl = await import('@testing-library/react');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const client = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  useUserStore.setState({ isAuthenticated: true });
  return { sse, rtl, client, wrapper };
}

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

describe('useSse callbacks', () => {
  it('delivers events to the onEvent of the latest render, not the first one', async () => {
    const { sse, rtl, wrapper } = await setup();
    const seen: string[] = [];
    const { rerender, unmount } = rtl.renderHook(
      ({ tag }) => sse.useSse({ onEvent: () => { seen.push(tag); } }),
      { wrapper, initialProps: { tag: 'first' } }
    );
    await rtl.act(async () => { await vi.advanceTimersByTimeAsync(0); });

    rerender({ tag: 'second' });
    FakeEventSource.instances[0].onopen!();
    FakeEventSource.instances[0].onmessage!(envelope('2-0', 'xp_updated'));

    expect(seen).toEqual(['second']);
    unmount();
  });

  it('extraInvalidateKeys only fire for the event types listed in invalidateOn', async () => {
    const { sse, rtl, client, wrapper } = await setup();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { unmount } = rtl.renderHook(
      () => sse.useSse({ extraInvalidateKeys: [['xp', 'state']], invalidateOn: ['xp_updated', 'level_up'] }),
      { wrapper }
    );
    await rtl.act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const es = FakeEventSource.instances[0];
    es.onopen!();

    es.onmessage!(envelope('3-0', 'notification_created'));
    es.onmessage!(envelope('4-0', 'interview.turn.delta'));
    expect(spy).not.toHaveBeenCalled();

    es.onmessage!(envelope('5-0', 'level_up'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['xp', 'state'] });
    unmount();
  });

  it('without invalidateOn the keys still fire for every event (old behaviour)', async () => {
    const { sse, rtl, client, wrapper } = await setup();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { unmount } = rtl.renderHook(() => sse.useSse({ extraInvalidateKeys: [['xp', 'state']] }), { wrapper });
    await rtl.act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const es = FakeEventSource.instances[0];
    es.onopen!();
    es.onmessage!(envelope('3-0', 'notification_created'));

    expect(spy).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('useSse reconnect backoff', () => {
  /** Drops the current stream and returns how long the hook waited before opening the next one. */
  async function dropAndMeasure() {
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    const before = FakeEventSource.instances.length;
    const t0 = Date.now();
    es.onerror!();
    while (FakeEventSource.instances.length === before) await vi.advanceTimersByTimeAsync(100);
    return Date.now() - t0;
  }

  it('resets after a stable connection, so isolated drops all wait the base delay', async () => {
    const { sse } = await setup();
    await sse.connectGlobalSse(vi.fn(), vi.fn());

    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      FakeEventSource.instances[FakeEventSource.instances.length - 1].onopen!();
      await vi.advanceTimersByTimeAsync(5_000); // healthy for a few seconds
      waits.push(await dropAndMeasure());
    }

    expect(waits.every((w) => w >= 3_000 && w <= 3_100)).toBe(true);
    sse.disconnectGlobalSse(vi.fn());
  });

  it('keeps backing off while connections drop before they are stable', async () => {
    const { sse } = await setup();
    await sse.connectGlobalSse(vi.fn(), vi.fn());

    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      FakeEventSource.instances[FakeEventSource.instances.length - 1].onopen!();
      await vi.advanceTimersByTimeAsync(1_000); // accepted, then dropped again quickly
      waits.push(await dropAndMeasure());
    }

    expect(waits[0]).toBeGreaterThanOrEqual(3_000);
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeGreaterThan(waits[1]);
    sse.disconnectGlobalSse(vi.fn());
  });

  it('a flapping connection still reaches the failure cap instead of being forgiven on every open', async () => {
    const { sse } = await setup();
    const setStatus = vi.fn();
    await sse.connectGlobalSse(setStatus, vi.fn());

    for (let i = 0; i < 4; i++) {
      FakeEventSource.instances[FakeEventSource.instances.length - 1].onopen!();
      await vi.advanceTimersByTimeAsync(500);
      await dropAndMeasure();
    }
    FakeEventSource.instances[FakeEventSource.instances.length - 1].onopen!();
    await vi.advanceTimersByTimeAsync(500);
    FakeEventSource.instances[FakeEventSource.instances.length - 1].onerror!();

    expect(setStatus).toHaveBeenLastCalledWith('disconnected');
    sse.disconnectGlobalSse(vi.fn());
  });
});
