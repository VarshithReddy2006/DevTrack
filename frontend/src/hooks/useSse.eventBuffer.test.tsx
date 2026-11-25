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

const makeEnvelope = (id: string, sequence: number, type: string = 'xp_updated', payload: Record<string, unknown> = {}) =>
  ({
    data: JSON.stringify({
      id,
      type,
      sequence,
      timestamp: new Date().toISOString(),
      userId: 'u1',
      payload: { ...payload, id, sequence },
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

describe('useSse event sequence deduplication and gap recovery buffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    post.mockReset();
    post.mockResolvedValue({ data: { data: { ticket: 'test-ticket' } } });
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

  it('delivers normal sequential events in order and updates lastEventId accurately', async () => {
    const { sse, rtl, wrapper } = await setup();
    const dispatched: any[] = [];
    const { unmount } = rtl.renderHook(
      () => sse.useSse({ onEvent: (e) => dispatched.push(e) }),
      { wrapper }
    );
    await rtl.act(async () => { await vi.advanceTimersByTimeAsync(0); });

    const es = FakeEventSource.instances[0];
    es.onopen!();

    es.onmessage!(makeEnvelope('stream-1', 1, 'xp_updated'));
    es.onmessage!(makeEnvelope('stream-2', 2, 'xp_updated'));
    es.onmessage!(makeEnvelope('stream-3', 3, 'xp_updated'));

    expect(dispatched).toHaveLength(3);
    expect(dispatched.map((e) => e.payload.sequence)).toEqual([1, 2, 3]);
    expect(sse.sseEventBuffer.getLastDispatchedCheckpoint()).toBe('stream-3');
    unmount();
  });

  it('detects and ignores duplicate sequence numbers and duplicate event IDs', async () => {
    const { sse, rtl, wrapper } = await setup();
    const dispatched: any[] = [];
    const { unmount } = rtl.renderHook(
      () => sse.useSse({ onEvent: (e) => dispatched.push(e) }),
      { wrapper }
    );
    await rtl.act(async () => { await vi.advanceTimersByTimeAsync(0); });

    const es = FakeEventSource.instances[0];
    es.onopen!();

    es.onmessage!(makeEnvelope('stream-1', 1, 'xp_updated'));
    // Duplicate ID and duplicate sequence
    es.onmessage!(makeEnvelope('stream-1', 1, 'xp_updated'));
    // Different ID but duplicate/lower sequence
    es.onmessage!(makeEnvelope('stream-1-dup', 1, 'xp_updated'));

    expect(dispatched).toHaveLength(1);
    expect(sse.sseEventBuffer.getLastDispatchedCheckpoint()).toBe('stream-1');
    unmount();
  });

  it('buffers out-of-order events (1, 2, 5, 4, 3) and dispatches in strict order (1, 2, 3, 4, 5)', async () => {
    const { sse, rtl, wrapper } = await setup();
    const dispatched: any[] = [];
    const { unmount } = rtl.renderHook(
      () => sse.useSse({ onEvent: (e) => dispatched.push(e) }),
      { wrapper }
    );
    await rtl.act(async () => { await vi.advanceTimersByTimeAsync(0); });

    const es = FakeEventSource.instances[0];
    es.onopen!();

    es.onmessage!(makeEnvelope('stream-1', 1));
    es.onmessage!(makeEnvelope('stream-2', 2));
    expect(dispatched.map((e) => e.payload.sequence)).toEqual([1, 2]);
    expect(sse.sseEventBuffer.getLastDispatchedCheckpoint()).toBe('stream-2');

    // Sequence 5 arrives (gap: 3 and 4 missing)
    es.onmessage!(makeEnvelope('stream-5', 5));
    // CRITICAL REPLAY CHECKPOINT: checkpoint must NOT advance to 5!
    expect(dispatched.map((e) => e.payload.sequence)).toEqual([1, 2]);
    expect(sse.sseEventBuffer.getLastDispatchedCheckpoint()).toBe('stream-2');
    expect(sse.sseEventBuffer.getBufferSize()).toBe(1);

    // Sequence 4 arrives (gap: 3 still missing)
    es.onmessage!(makeEnvelope('stream-4', 4));
    expect(dispatched.map((e) => e.payload.sequence)).toEqual([1, 2]);
    expect(sse.sseEventBuffer.getLastDispatchedCheckpoint()).toBe('stream-2');
    expect(sse.sseEventBuffer.getBufferSize()).toBe(2);

    // Missing sequence 3 arrives!
    es.onmessage!(makeEnvelope('stream-3', 3));
    // Now all buffered events 3, 4, 5 should be dispatched in strict order!
    expect(dispatched.map((e) => e.payload.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(sse.sseEventBuffer.getLastDispatchedCheckpoint()).toBe('stream-5');
    expect(sse.sseEventBuffer.getBufferSize()).toBe(0);
    unmount();
  });

  it('triggers gap recovery reconnect when a missing sequence does not arrive within 200ms', async () => {
    const { sse, rtl, wrapper } = await setup();
    const dispatched: any[] = [];
    const { unmount } = rtl.renderHook(
      () => sse.useSse({ onEvent: (e) => dispatched.push(e) }),
      { wrapper }
    );
    await rtl.act(async () => { await vi.advanceTimersByTimeAsync(0); });

    const es = FakeEventSource.instances[0];
    es.onopen!();

    es.onmessage!(makeEnvelope('stream-1', 1));
    // Sequence 3 arrives without sequence 2
    es.onmessage!(makeEnvelope('stream-3', 3));
    expect(dispatched.map((e) => e.payload.sequence)).toEqual([1]);
    expect(sse.sseEventBuffer.getBufferSize()).toBe(1);

    // Advance timer past the 200ms gap timeout
    await rtl.act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    // EventSource should have been closed to initiate gap recovery reconnect
    expect(es.close).toHaveBeenCalled();

    // Advance timers for the reconnect backoff
    await rtl.act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // Second EventSource instance should have been opened
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
    const newEs = FakeEventSource.instances[FakeEventSource.instances.length - 1];

    // Verify lastEventId in reconnect URL uses the last in-order checkpoint ('stream-1'), NOT 'stream-3'
    expect(newEs.url).toContain('lastEventId=stream-1');
    unmount();
  });

  it('resets buffer and cancels timers on disconnect and test reset', async () => {
    const { sse, rtl, wrapper } = await setup();
    const { unmount } = rtl.renderHook(
      () => sse.useSse(),
      { wrapper }
    );
    await rtl.act(async () => { await vi.advanceTimersByTimeAsync(0); });

    const es = FakeEventSource.instances[0];
    es.onopen!();
    es.onmessage!(makeEnvelope('stream-1', 1));
    es.onmessage!(makeEnvelope('stream-3', 3)); // buffered

    expect(sse.sseEventBuffer.getBufferSize()).toBe(1);

    // Disconnect
    sse.disconnectGlobalSse();
    expect(sse.sseEventBuffer.getBufferSize()).toBe(0);
    expect(sse.sseEventBuffer.getLastDispatchedCheckpoint()).toBeNull();
    unmount();
  });
});
