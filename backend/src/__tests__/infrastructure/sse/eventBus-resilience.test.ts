import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let mockRedisStatus = 'ready';
const mockRedisConstructor = vi.fn();
const mockSubscribeFn = vi.fn().mockResolvedValue(undefined);

vi.mock('ioredis', () => {
  return {
    default: class MockRedis {
      public status: string;
      private handlers: Record<string, ((...args: any[]) => void)[]> = {};

      constructor(...args: any[]) {
        this.status = mockRedisStatus;
        mockRedisConstructor(...args);
      }

      on(event: string, handler: (...args: any[]) => void) {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        if (this.handlers[event]) {
          for (const handler of this.handlers[event]) {
            handler(...args);
          }
        }
      }

      connect = vi.fn().mockImplementation(async () => {
        if (this.status === 'ready') {
          this.emit('ready');
        }
        return undefined;
      });

      subscribe = mockSubscribeFn;
      publish = vi.fn().mockResolvedValue(1);
      disconnect = vi.fn().mockImplementation(() => {
        this.status = 'end';
      });
    },
  };
});

import { EventBus, SseClient, SseEvent } from '../../../shared/sse/eventBus.js';

describe('EventBus Resilience & Degraded Mode (No Redis)', () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalRedisHost = process.env.REDIS_HOST;

  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    mockRedisStatus = 'ready';
    mockRedisConstructor.mockClear();
    mockSubscribeFn.mockClear();
  });

  afterEach(() => {
    if (originalRedisUrl !== undefined) {
      process.env.REDIS_URL = originalRedisUrl;
    } else {
      delete process.env.REDIS_URL;
    }
    if (originalRedisHost !== undefined) {
      process.env.REDIS_HOST = originalRedisHost;
    } else {
      delete process.env.REDIS_HOST;
    }
  });

  function createMockClient(id: string, userId: string): { client: SseClient; enqueuedChunks: string[] } {
    const enqueuedChunks: string[] = [];
    const decoder = new TextDecoder();

    const client: SseClient = {
      id,
      userId,
      connectedAt: Date.now(),
      controller: {
        desiredSize: 1,
        close: vi.fn(),
        error: vi.fn(),
        enqueue: vi.fn((chunk: Uint8Array) => {
          enqueuedChunks.push(decoder.decode(chunk));
        }),
      } as unknown as ReadableStreamDefaultController<Uint8Array>,
      emit: vi.fn(),
      destroy: vi.fn(),
    };

    return { client, enqueuedChunks };
  }

  it('skips Redis PubSub and does not instantiate ioredis when REDIS_URL is absent', () => {
    delete process.env.REDIS_URL;

    const bus = new EventBus();
    expect(bus.hasRedisPubSub()).toBe(false);
    expect(mockRedisConstructor).not.toHaveBeenCalled();

    bus.shutdown();
  });

  it('returns true for hasRedisPubSub() only when both clients are ready and avoids duplicate subscribe calls', async () => {
    process.env.REDIS_URL = 'redis://render-redis.internal:6379';
    mockRedisStatus = 'ready';

    const bus = new EventBus();
    // Allow async initRedisPubSub to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockRedisConstructor).toHaveBeenCalled();
    expect(mockRedisConstructor).toHaveBeenCalledWith(
      'redis://render-redis.internal:6379',
      expect.objectContaining({ lazyConnect: true })
    );

    // Both subscriber and publisher are ready
    expect(bus.hasRedisPubSub()).toBe(true);

    // Channel subscribe should only be called once (no duplicate calls between setup and ready listener)
    expect(mockSubscribeFn).toHaveBeenCalledTimes(1);

    bus.shutdown();
  });

  it('prevents concurrent duplicate subscribe calls when subscribe promise is in-flight', async () => {
    process.env.REDIS_URL = 'redis://render-redis.internal:6379';
    mockRedisStatus = 'ready';

    let resolveSubscribe!: () => void;
    const pendingSubscribe = new Promise<void>((resolve) => {
      resolveSubscribe = resolve;
    });

    mockSubscribeFn.mockImplementation(() => pendingSubscribe);

    const bus = new EventBus();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Under the race condition without single-flight, both ready listener and setup path call subscribe()
    expect(mockSubscribeFn).toHaveBeenCalledTimes(1);

    resolveSubscribe();
    await new Promise((resolve) => setTimeout(resolve, 50));
    bus.shutdown();
  });

  it('clears in-flight promise on subscription failure so subsequent ready event can retry', async () => {
    process.env.REDIS_URL = 'redis://render-redis.internal:6379';
    mockRedisStatus = 'ready';

    let attempt = 0;
    mockSubscribeFn.mockImplementation(async () => {
      attempt++;
      if (attempt <= 2) {
        throw new Error('Redis subscription timeout');
      }
      return undefined;
    });

    const bus = new EventBus();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Initial attempts (ready event + setup fallback) both failed
    expect(attempt).toBe(2);

    // Simulate subsequent ready event firing after reconnect
    const subscriber = (bus as any).redisSubscriber;
    expect(subscriber).toBeDefined();
    subscriber.emit('ready');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Subsequent ready event successfully retried
    expect(attempt).toBe(3);

    bus.shutdown();
  });

  it('returns false for hasRedisPubSub() when clients are instantiated but not ready', async () => {
    process.env.REDIS_URL = 'redis://render-redis.internal:6379';
    mockRedisStatus = 'connecting'; // Clients exist, but are connecting / not ready

    const bus = new EventBus();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockRedisConstructor).toHaveBeenCalled();
    // Clients were instantiated, but since status is 'connecting', hasRedisPubSub must return false
    expect(bus.hasRedisPubSub()).toBe(false);

    bus.shutdown();
  });

  it('delivers targeted events locally in degraded mode', () => {
    delete process.env.REDIS_URL;
    const bus = new EventBus();

    const { client: client1, enqueuedChunks: chunks1 } = createMockClient('client-1', 'user-42');
    const { client: client2, enqueuedChunks: chunks2 } = createMockClient('client-2', 'user-99');

    bus.register(client1);
    bus.register(client2);

    const targetedEvent: SseEvent = {
      type: 'sync_completed',
      timestamp: new Date().toISOString(),
      userId: 'user-42',
      platform: 'leetcode',
      stats: { ingested: 5, successCount: 5, failedCount: 0 },
      payload: { syncId: 'sync-100' },
    };

    // Publish targeted event for user-42
    bus.publish(targetedEvent, 'user-42');

    expect(chunks1).toHaveLength(1);
    expect(chunks1[0]).toContain('"type":"sync_completed"');
    expect(chunks1[0]).toContain('"platform":"leetcode"');
    expect(chunks1[0]).toContain('"userId":"user-42"');

    // Client 2 (user-99) should not receive user-42's event
    expect(chunks2).toHaveLength(0);

    bus.shutdown();
  });

  it('broadcasts untargeted events to all local clients in degraded mode', () => {
    delete process.env.REDIS_URL;
    const bus = new EventBus();

    const { client: client1, enqueuedChunks: chunks1 } = createMockClient('client-1', 'user-1');
    const { client: client2, enqueuedChunks: chunks2 } = createMockClient('client-2', 'user-2');

    bus.register(client1);
    bus.register(client2);

    const broadcastEvent: SseEvent = {
      type: 'sync_started',
      timestamp: new Date().toISOString(),
      userId: 'system',
      platform: 'system',
      payload: { syncId: 'sync-broadcast' },
    };

    bus.publish(broadcastEvent);

    expect(chunks1).toHaveLength(1);
    expect(chunks2).toHaveLength(1);
    expect(chunks1[0]).toContain('"sync-broadcast"');
    expect(chunks2[0]).toContain('"sync-broadcast"');

    bus.shutdown();
  });

  it('tracks operational metrics accurately without Redis', () => {
    delete process.env.REDIS_URL;
    const bus = new EventBus();

    const { client } = createMockClient('client-metric', 'user-metric');
    bus.register(client);

    let metrics = bus.getMetrics();
    expect(metrics.activeConnections).toBe(1);
    expect(metrics.totalConnections).toBe(1);
    expect(metrics.eventsPublished).toBe(0);

    bus.publish({
      type: 'sync_started',
      timestamp: new Date().toISOString(),
      platform: 'github',
      payload: { syncId: 's-1' },
    });

    metrics = bus.getMetrics();
    expect(metrics.eventsPublished).toBe(1);

    bus.unregister('client-metric');
    metrics = bus.getMetrics();
    expect(metrics.activeConnections).toBe(0);
    expect(metrics.totalDisconnects).toBe(1);

    bus.shutdown();
  });

  it('shuts down cleanly without errors when Redis was never initialized', () => {
    delete process.env.REDIS_URL;
    const bus = new EventBus();
    const { client } = createMockClient('client-shutdown', 'user-shutdown');

    bus.register(client);
    expect(() => bus.shutdown()).not.toThrow();

    const metrics = bus.getMetrics();
    expect(metrics.activeConnections).toBe(0);
  });
});
