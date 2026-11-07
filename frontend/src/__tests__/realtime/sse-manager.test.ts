import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_CAP_MS,
  STABLE_CONNECTION_MS,
  __resetSseManagerForTests,
  computeBackoffDelay,
  sequenceFromEventId,
  useSseStore,
  type SseEvent,
} from '../../lib/realtime/sse-manager';
import { getSSEHandshakeTicket } from '../../services/authService';
import { queryClient } from '../../lib/queryClient';

vi.mock('../../services/authService', () => ({
  getSSEHandshakeTicket: vi.fn(),
}));

vi.mock('../../lib/queryClient', () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));

// ---------------------------------------------------------------------------
// EventSource test double (jsdom does not implement EventSource)
// ---------------------------------------------------------------------------
class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.(new Event('open'));
  }

  fail() {
    this.onerror?.(new Event('error'));
  }

  emit(data: Record<string, unknown>, lastEventId = '') {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data), lastEventId }));
  }
}

let online = true;

function latest(): MockEventSource {
  const source = MockEventSource.instances.at(-1);
  if (!source) throw new Error('No EventSource was created');
  return source;
}

/** Let the async connect() (dynamic import + ticket fetch) finish. */
async function settle() {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function connect() {
  await useSseStore.getState().connect();
  await settle();
}

/** Advance fake time and let any reconnect it triggers finish. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function setOnline(value: boolean) {
  online = value;
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.clearAllMocks();
  vi.mocked(getSSEHandshakeTicket).mockResolvedValue('ticket-1');
  vi.stubGlobal('EventSource', MockEventSource);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  online = true;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  MockEventSource.instances = [];
  localStorage.setItem('devtrack_access_token', 'token');
  __resetSseManagerForTests();
});

afterEach(() => {
  __resetSseManagerForTests();
  localStorage.clear();
  delete (window.navigator as { onLine?: boolean }).onLine;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------
describe('computeBackoffDelay', () => {
  it('applies full jitter below an exponentially growing ceiling', () => {
    expect(computeBackoffDelay(0, () => 0)).toBe(0);
    expect(computeBackoffDelay(0, () => 0.999)).toBe(999);
    expect(computeBackoffDelay(1, () => 0.999)).toBe(1998);
    expect(computeBackoffDelay(3, () => 0.5)).toBe(4000);
  });

  it('never exceeds the cap', () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      expect(computeBackoffDelay(attempt, () => 0.9999)).toBeLessThan(BACKOFF_CAP_MS);
    }
    expect(computeBackoffDelay(10, () => 0.5)).toBe(BACKOFF_CAP_MS / 2);
  });
});

describe('reconnection backoff', () => {
  it('waits a jittered exponential delay between consecutive failures', async () => {
    await connect();
    expect(MockEventSource.instances).toHaveLength(1);

    // attempt 0 → 0.5 * 1000ms, attempt 1 → 0.5 * 2000ms, attempt 2 → 0.5 * 4000ms
    for (const [index, delay] of [500, 1000, 2000].entries()) {
      latest().fail();
      expect(latest().closed).toBe(true);

      await advance(delay - 1);
      expect(MockEventSource.instances).toHaveLength(index + 1);

      await advance(1);
      expect(MockEventSource.instances).toHaveLength(index + 2);
    }

    expect(getSSEHandshakeTicket).toHaveBeenCalledTimes(4);
  });

  it('does not reset attempts when the connection drops within the stability window', async () => {
    await connect();
    latest().fail(); // attempt 0 → 500ms
    await advance(500);
    expect(MockEventSource.instances).toHaveLength(2);

    latest().open();
    expect(useSseStore.getState().connectionState.connected).toBe(true);
    await advance(STABLE_CONNECTION_MS - 1);
    latest().fail(); // still attempt 1 → 1000ms

    await advance(999);
    expect(MockEventSource.instances).toHaveLength(2);
    await advance(1);
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it('resets attempts once the connection has been stable', async () => {
    await connect();
    latest().fail(); // attempt 0 → 500ms
    await advance(500);

    latest().open();
    await advance(STABLE_CONNECTION_MS);
    latest().fail(); // back to attempt 0 → 500ms

    await advance(499);
    expect(MockEventSource.instances).toHaveLength(2);
    await advance(1);
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it('resumes from the last event ID on reconnect', async () => {
    await connect();
    latest().open();
    latest().emit(
      { type: 'xp_updated', timestamp: '2026-11-07T10:00:00.000Z', payload: { xp: 10 } },
      'user_1-7-1762509600000',
    );
    latest().fail();
    await advance(500);

    const url = new URL(latest().url, 'http://localhost');
    expect(url.searchParams.get('ticket')).toBe('ticket-1');
    expect(url.searchParams.get('lastEventId')).toBe('user_1-7-1762509600000');
  });
});

// ---------------------------------------------------------------------------
// Network awareness
// ---------------------------------------------------------------------------
describe('online / offline handling', () => {
  it('pauses retries while offline and reconnects immediately when back online', async () => {
    await connect();
    latest().fail(); // reconnect scheduled in 500ms

    setOnline(false);
    expect(useSseStore.getState().connectionState).toMatchObject({
      offline: true,
      reconnecting: false,
      connected: false,
    });

    await advance(10 * BACKOFF_CAP_MS);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(getSSEHandshakeTicket).toHaveBeenCalledTimes(1);

    vi.mocked(getSSEHandshakeTicket).mockResolvedValue('ticket-2');
    setOnline(true);
    await settle(); // no timer advance needed

    expect(MockEventSource.instances).toHaveLength(2);
    expect(latest().url).toContain('ticket=ticket-2');
    expect(useSseStore.getState().connectionState.offline).toBe(false);
  });

  it('closes an open connection when the browser goes offline', async () => {
    await connect();
    latest().open();

    setOnline(false);
    expect(latest().closed).toBe(true);
    expect(useSseStore.getState().connectionState.connected).toBe(false);
  });

  it('waits for the network instead of connecting while already offline', async () => {
    online = false;
    await connect();
    expect(MockEventSource.instances).toHaveLength(0);
    expect(useSseStore.getState().connectionState.offline).toBe(true);

    setOnline(true);
    await settle();
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('ignores network events after disconnect', async () => {
    await connect();
    useSseStore.getState().disconnect();

    setOnline(false);
    setOnline(true);
    await settle();
    expect(MockEventSource.instances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------
describe('event deduplication', () => {
  async function openWithListener(type: SseEvent['type'] = 'xp_updated') {
    const received: SseEvent[] = [];
    useSseStore.getState().subscribe(type, (event) => received.push(event));
    await connect();
    latest().open();
    return received;
  }

  it('drops events whose sequence is not newer than the last one', async () => {
    const received = await openWithListener();
    const at = (s: number) => `2026-11-07T10:00:0${s}.000Z`;

    latest().emit({ id: 'a', type: 'xp_updated', sequence: 1, timestamp: at(1), payload: {} });
    latest().emit({ id: 'b', type: 'xp_updated', sequence: 2, timestamp: at(2), payload: {} });
    latest().emit({ id: 'b2', type: 'xp_updated', sequence: 2, timestamp: at(2), payload: {} });
    latest().emit({ id: 'a2', type: 'xp_updated', sequence: 1, timestamp: at(1), payload: {} });
    latest().emit({ id: 'c', type: 'xp_updated', sequence: 3, timestamp: at(3), payload: {} });

    expect(received.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(useSseStore.getState().lastSequence).toBe(3);
  });

  it('matches a replayed envelope against the live event it duplicates', async () => {
    const received = await openWithListener();
    const timestamp = '2026-11-07T10:00:00.000Z';

    // Live event: sequence only encoded in the ID
    latest().emit(
      { id: 'user_1-5-1762509600000', type: 'xp_updated', timestamp, payload: { xp: 5 } },
      'user_1-5-1762509600000',
    );
    // Replay after reconnect: Redis stream ID + explicit sequence
    latest().emit(
      { id: '1762509600000-0', type: 'xp_updated', sequence: 5, timestamp, payload: { xp: 5 } },
      '1762509600000-0',
    );

    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ xp: 5 });
  });

  it('accepts a lower sequence with a newer timestamp (server counter reset)', async () => {
    const received = await openWithListener();
    latest().emit({ id: 'x', type: 'xp_updated', sequence: 40, timestamp: '2026-11-07T10:00:00.000Z', payload: {} });
    latest().emit({ id: 'y', type: 'xp_updated', sequence: 1, timestamp: '2026-11-07T10:20:00.000Z', payload: {} });

    expect(received).toHaveLength(2);
    expect(useSseStore.getState().lastSequence).toBe(1);
  });

  it('falls back to event IDs or content when there is no sequence', async () => {
    const received = await openWithListener();
    const fallback = { type: 'xp_updated', timestamp: '2026-11-07T10:00:00.000Z', payload: { xp: 1 } };

    latest().emit(fallback, 'user_1-fallback-1762509600-1762509600000');
    latest().emit(fallback, 'user_1-fallback-1762509600-1762509600000');
    expect(received).toHaveLength(1);

    const anonymous = { type: 'xp_updated', timestamp: '2026-11-07T10:01:00.000Z', data: { xp: 2 } };
    latest().emit(anonymous);
    latest().emit(anonymous);
    expect(received).toHaveLength(2);
  });

  it('parses sequences only from live event IDs', () => {
    expect(sequenceFromEventId('user_1-12-1762509600000')).toBe(12);
    expect(sequenceFromEventId('1762509600000-0')).toBeUndefined();
    expect(sequenceFromEventId('user_1-fallback-1762509600-1762509600000')).toBeUndefined();
    expect(sequenceFromEventId('user_1-full-1762509600000')).toBeUndefined();
    expect(sequenceFromEventId(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Snapshot reset
// ---------------------------------------------------------------------------
describe('snapshot reset', () => {
  it('stores the full state, notifies subscribers and invalidates queries', async () => {
    const snapshots: SseEvent[] = [];
    useSseStore.getState().subscribe('runtime_state_full', (event) => snapshots.push(event));
    const received: SseEvent[] = [];
    useSseStore.getState().subscribe('xp_updated', (event) => received.push(event));

    await connect();
    latest().open();
    latest().emit({ id: 'a', type: 'xp_updated', sequence: 9, timestamp: '2026-11-07T10:00:00.000Z', payload: {} });

    latest().emit({
      id: 'user_1-full-1762509700000',
      type: 'runtime_state_full',
      sequence: 0,
      timestamp: '2026-11-07T10:00:00.000Z',
      payload: { state: { xp: 120 } },
    });

    const state = useSseStore.getState();
    expect(state.snapshot).toEqual({ xp: 120 });
    expect(state.lastSequence).toBeNull();
    expect(snapshots).toHaveLength(1);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(1);

    // New baseline: a sequence below the pre-snapshot one is accepted
    latest().emit({ id: 'b', type: 'xp_updated', sequence: 1, timestamp: '2026-11-07T09:59:00.000Z', payload: {} });
    expect(received).toHaveLength(2);
  });
});
