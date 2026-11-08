import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Minimal in-memory stand-in for a shared Redis: every instance created through the
// ioredis mock below sees the same set of pub/sub subscribers.
type MessageHandler = (channel: string, message: string) => void;
const subscribersByChannel = new Map<string, Set<MessageHandler>>();
const constructedWith: unknown[][] = [];

vi.mock('ioredis', () => {
  return {
    default: class FakeRedis {
      public status = 'ready';
      public options: Record<string, unknown> = {};
      private handlers: Record<string, ((...args: any[]) => void)[]> = {};

      constructor(...args: unknown[]) {
        constructedWith.push(args);
        const last = args[args.length - 1];
        if (last && typeof last === 'object') this.options = last as Record<string, unknown>;
      }

      on(event: string, handler: (...args: any[]) => void) {
        (this.handlers[event] ||= []).push(handler);
        return this;
      }

      emit(event: string, ...args: any[]) {
        for (const handler of this.handlers[event] ?? []) handler(...args);
      }

      connect = vi.fn().mockImplementation(async () => {
        this.emit('ready');
      });

      subscribe = vi.fn().mockImplementation(async (channel: string) => {
        const set = subscribersByChannel.get(channel) ?? new Set<MessageHandler>();
        for (const handler of this.handlers['message'] ?? []) set.add(handler as MessageHandler);
        subscribersByChannel.set(channel, set);
      });

      publish = vi.fn().mockImplementation(async (channel: string, message: string) => {
        const set = subscribersByChannel.get(channel);
        for (const handler of set ?? []) handler(channel, message);
        return set?.size ?? 0;
      });

      disconnect = vi.fn().mockImplementation(() => {
        this.status = 'end';
      });
    },
  };
});

import { EventBus, type SseClient, type SseEvent } from '../../../shared/sse/eventBus.js';
import { getRedisClient, isRedisConfigured, createRedisConnection } from '../../../shared/redis/client.js';

function makeClient(id: string, userId: string): { client: SseClient; chunks: string[] } {
  const chunks: string[] = [];
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
        chunks.push(decoder.decode(chunk));
      }),
    } as unknown as ReadableStreamDefaultController<Uint8Array>,
    emit: vi.fn(),
    destroy: vi.fn(),
  };
  return { client, chunks };
}

describe('Redis config from discrete host/port variables', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_PASSWORD;
    constructedWith.length = 0;
    subscribersByChannel.clear();
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('is not configured when neither REDIS_URL nor REDIS_HOST is set', () => {
    expect(isRedisConfigured()).toBe(false);
  });

  it('is configured by REDIS_HOST alone', () => {
    process.env.REDIS_HOST = 'redis';
    expect(isRedisConfigured()).toBe(true);
  });

  it('connects with host, port and password when REDIS_URL is unset', () => {
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6380';
    process.env.REDIS_PASSWORD = 's3cret';

    createRedisConnection({ lazyConnect: true });

    expect(constructedWith).toHaveLength(1);
    expect(constructedWith[0][0]).toMatchObject({
      host: 'redis',
      port: 6380,
      password: 's3cret',
      lazyConnect: true,
    });
  });

  it('prefers REDIS_URL when both are set', () => {
    process.env.REDIS_URL = 'redis://cache.internal:6379';
    process.env.REDIS_HOST = 'redis';

    createRedisConnection();

    expect(constructedWith[0][0]).toBe('redis://cache.internal:6379');
  });
});

describe('EventBus cross-instance delivery over shared Redis', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.REDIS_URL;
    process.env.REDIS_HOST = 'redis';
    constructedWith.length = 0;
    subscribersByChannel.clear();
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('delivers an event published on instance A to a client on instance B', async () => {
    // Opens the shared client that publishToRedis() checks before it publishes.
    getRedisClient();

    const busA = new EventBus();
    const busB = new EventBus();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { client, chunks } = makeClient('c1', 'user-1');
    busB.register(client);

    const event: SseEvent = {
      type: 'runtime_state_patch',
      timestamp: new Date().toISOString(),
      userId: 'user-1',
      payload: { xp: 42 },
    };
    busA.publish(event, 'user-1');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const received = chunks.join('');
    expect(received).toContain('data: ');
    expect(received).toContain('"xp":42');

    busA.shutdown();
    busB.shutdown();
  });

  it('subscribes again after the subscriber connection closes and recovers', async () => {
    const bus = new EventBus();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const subscriber = (bus as any).redisSubscriber;
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);

    subscriber.emit('close');
    subscriber.emit('ready');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    bus.shutdown();
  });
});
