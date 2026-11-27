import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/redis/client.js', () => ({
  getRedisClient: () => ({}),
  getRedisHealth: () => ({ status: 'disconnected' }),
  isRedisConfigured: () => false,
  createRedisConnection: vi.fn(),
}));

vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: {
    getRuntimeState: vi.fn(async () => null),
    getRuntimeStateFresh: vi.fn(async () => null),
  },
}));

import {
  DEFAULT_MAX_SUBSCRIBER_QUEUE_BYTES,
  DEFAULT_MAX_SUBSCRIBER_QUEUE_EVENTS,
  EventBus,
  type SseClient,
  type SseEvent,
} from '../../../shared/sse/eventBus.js';
import {
  createSseStream,
  createSseWritableSink,
  SSE_DRAIN_TIMEOUT_MS,
} from '../../../shared/sse/sseHandler.js';

const decoder = new TextDecoder();

function makeEvent(seq: number, extraPayload: Record<string, unknown> = {}): SseEvent {
  return {
    id: `evt-${seq}`,
    type: 'sync_started',
    timestamp: '2026-11-27T00:00:00.000Z',
    userId: 'user-1',
    payload: { seq, ...extraPayload },
  };
}

function createBackpressureClient(
  id: string,
  userId: string,
  opts: { initialBackpressured?: boolean } = {},
) {
  const frames: string[] = [];
  let backpressured = opts.initialBackpressured ?? false;
  let desiredSize = backpressured ? 0 : 1;
  const terminate = vi.fn();
  const close = vi.fn();
  const destroy = vi.fn();

  const client: SseClient = {
    id,
    userId,
    connectedAt: Date.now(),
    controller: {
      enqueue: (chunk: Uint8Array) => {
        frames.push(decoder.decode(chunk));
      },
      close,
      get desiredSize() {
        return desiredSize;
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>,
    isBackpressured: () => backpressured,
    terminate,
    emit: () => undefined,
    destroy,
  };

  return {
    client,
    frames,
    terminate,
    close,
    destroy,
    setBackpressured(value: boolean) {
      backpressured = value;
      desiredSize = value ? 0 : 1;
    },
  };
}

class MockSseResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  written: string[] = [];
  allowWrite = true;

  write = vi.fn((chunk: Uint8Array) => {
    this.written.push(decoder.decode(chunk));
    return this.allowWrite;
  });

  end = vi.fn(() => {
    this.writableEnded = true;
    this.emit('close');
  });
}

describe('EventBus subscriber backpressure & bounded buffers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('buffers events up to maxSubscriberQueueEvents while backpressured and flushes in FIFO order on drain', () => {
    const bus = new EventBus(undefined, {
      maxSubscriberQueueEvents: 50,
      maxSubscriberQueueBytes: 256 * 1024,
      stallTimeoutMs: 10_000,
    });
    const slow = createBackpressureClient('slow-1', 'user-1', { initialBackpressured: true });
    bus.register(slow.client);

    for (let i = 1; i <= 5; i++) {
      bus.publish(makeEvent(i), 'user-1');
    }

    expect(slow.frames).toHaveLength(0);
    expect(bus.getMetrics()).toMatchObject({
      activeConnections: 1,
      bufferedEvents: 5,
      backpressureDrops: 0,
      stalledDisconnects: 0,
    });

    slow.setBackpressured(false);
    bus.notifyClientDrain('slow-1');

    expect(slow.frames).toHaveLength(5);
    expect(slow.frames[0]).toContain('id: evt-1');
    expect(slow.frames[4]).toContain('id: evt-5');
    expect(bus.getMetrics()).toMatchObject({
      activeConnections: 1,
      bufferedEvents: 0,
      bufferedBytes: 0,
    });

    bus.shutdown();
  });

  it('disconnects slow client when queued event count exceeds maxSubscriberQueueEvents (50)', () => {
    expect(DEFAULT_MAX_SUBSCRIBER_QUEUE_EVENTS).toBe(50);
    const bus = new EventBus();
    const slow = createBackpressureClient('slow-overflow', 'user-1', { initialBackpressured: true });
    const fast = createBackpressureClient('fast-1', 'user-1', { initialBackpressured: false });
    bus.register(slow.client);
    bus.register(fast.client);

    // 50 events fit in the queue; 51st triggers overflow disconnect
    for (let i = 1; i <= 50; i++) {
      bus.publish(makeEvent(i), 'user-1');
    }
    expect(bus.getMetrics().activeConnections).toBe(2);
    expect(bus.getMetrics().bufferedEvents).toBe(50);

    bus.publish(makeEvent(51), 'user-1');

    expect(slow.terminate).toHaveBeenCalledTimes(1);
    expect(slow.close).toHaveBeenCalledTimes(1);
    expect(slow.destroy).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics()).toMatchObject({
      activeConnections: 1,
      bufferedEvents: 0,
      bufferedBytes: 0,
      backpressureDrops: 1,
      stalledDisconnects: 1,
    });
    // Fast sibling client for the same user received all 51 events undisturbed
    expect(fast.frames).toHaveLength(51);

    bus.shutdown();
  });

  it('disconnects slow client when queued bytes exceed maxSubscriberQueueBytes (256KB)', () => {
    expect(DEFAULT_MAX_SUBSCRIBER_QUEUE_BYTES).toBe(256 * 1024);
    const bus = new EventBus();
    const slow = createBackpressureClient('slow-bytes', 'user-1', { initialBackpressured: true });
    bus.register(slow.client);

    const bigPadding = 'x'.repeat(20 * 1024); // ~20 KB per event -> >256 KB by event 14
    for (let i = 1; i <= 15; i++) {
      bus.publish(makeEvent(i, { padding: bigPadding }), 'user-1');
    }

    expect(slow.terminate).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics().activeConnections).toBe(0);
    expect(bus.getMetrics().bufferedBytes).toBe(0);
    expect(bus.getMetrics().backpressureDrops).toBe(1);

    bus.shutdown();
  });

  it('forcefully disconnects stalled client that fails to drain within 10 seconds', async () => {
    const bus = new EventBus(undefined, { stallTimeoutMs: 10_000 });
    const stalled = createBackpressureClient('stalled-1', 'user-1', { initialBackpressured: true });
    bus.register(stalled.client);

    bus.publish(makeEvent(1), 'user-1');
    expect(bus.getMetrics().bufferedEvents).toBe(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(bus.getMetrics().activeConnections).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(stalled.terminate).toHaveBeenCalledTimes(1);
    expect(stalled.close).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics()).toMatchObject({
      activeConnections: 0,
      bufferedEvents: 0,
      stalledDisconnects: 1,
    });

    bus.shutdown();
  });

  it('does not queue duplicate heartbeats into a backpressured subscriber buffer', () => {
    const bus = new EventBus();
    const slow = createBackpressureClient('slow-hb', 'user-1', { initialBackpressured: true });
    bus.register(slow.client);

    bus.startHeartbeat();
    vi.advanceTimersByTime(25_000);
    // Heartbeat skipped queueing while backed up; stall timer started and eventually evicts at +10s
    expect(bus.getMetrics().bufferedEvents).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(slow.terminate).toHaveBeenCalledTimes(1);
    expect(bus.getMetrics().activeConnections).toBe(0);

    bus.shutdown();
  });
});

describe('sseHandler writable sink backpressure & drain timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pauses on res.write() => false, resumes on drain, and terminates on 10s stall timeout', async () => {
    expect(SSE_DRAIN_TIMEOUT_MS).toBe(10_000);
    const res = new MockSseResponse();
    res.allowWrite = false;
    const onDrain = vi.fn();
    const onUnregister = vi.fn();

    const sink = createSseWritableSink(res as unknown as Response, 'c-1', 'req-1', {
      onDrain,
      onUnregister,
    });
    const writer = sink.writable.getWriter();

    const firstWrite = writer.write(new TextEncoder().encode('data: {"a":1}\n\n'));
    await Promise.resolve();
    expect(sink.isBackpressured()).toBe(true);
    expect(res.write).toHaveBeenCalledTimes(1);

    // Emit drain after 2s: write resolves and resumes
    await vi.advanceTimersByTimeAsync(2000);
    res.allowWrite = true;
    res.emit('drain');
    await firstWrite;

    expect(sink.isBackpressured()).toBe(false);
    expect(onDrain).toHaveBeenCalledTimes(1);

    // Next write triggers backpressure and never drains within 10s -> res.end() + reject
    res.allowWrite = false;
    const stalledWrite = writer.write(new TextEncoder().encode('data: {"a":2}\n\n'));
    const rejectionExpectation = expect(stalledWrite).rejects.toThrow('SSE client drain timeout exceeded');

    await vi.advanceTimersByTimeAsync(10_000);
    await rejectionExpectation;

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(onUnregister).toHaveBeenCalledTimes(1);
  });

  it('wires createSseStream pull() to drain EventBus buffered chunks', async () => {
    const stream = createSseStream('user-pull', 'client-pull', 'req-pull');
    const reader = stream.getReader();

    // First chunk is the initial runtime state / error bootstrap frame
    const initial = await reader.read();
    expect(initial.done).toBe(false);

    const { eventBus } = await import('../../../shared/sse/eventBus.js');
    eventBus.publish(makeEvent(99), 'user-pull');

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(decoder.decode(value)).toContain('id: evt-99');

    await reader.cancel();
    eventBus.unregister('client-pull');
  });
});
