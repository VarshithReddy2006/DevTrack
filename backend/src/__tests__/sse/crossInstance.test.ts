import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// Minimal in-memory Redis pub/sub shared by every connection, standing in for one Redis server.
const hub = new EventEmitter();

class FakeConnection extends EventEmitter {
  status = 'wait';
  async connect() {
    this.status = 'ready';
    setTimeout(() => this.emit('ready'), 0);
  }
  async subscribe(channel: string) {
    hub.on(channel, (m: string) => this.emit('message', channel, m));
  }
  async publish(channel: string, message: string) {
    hub.emit(channel, message);
    return 1;
  }
}

vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => new FakeConnection(),
  getRedisHealth: () => ({ status: 'disconnected' }),
  isRedisConfigured: () => true,
  createRedisConnection: () => new FakeConnection(),
}));

import { EventBus, type SseClient, type SseEvent } from '../../shared/sse/eventBus.js';

const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function client(bus: EventBus, userId: string) {
  const frames: string[] = [];
  const c = {
    id: `${userId}-${Math.random()}`,
    userId,
    connectedAt: Date.now(),
    controller: { enqueue: (b: Uint8Array) => frames.push(new TextDecoder().decode(b)) },
    emit: () => undefined,
    destroy: () => undefined,
  } as unknown as SseClient;
  bus.register(c);
  return frames;
}

const event = (userId: string): SseEvent =>
  ({ id: '1-0', type: 'runtime_state_patch', timestamp: 't', userId, payload: { x: 1 } }) as unknown as SseEvent;

describe('SSE delivery across event bus instances', () => {
  it('delivers an event published on instance A to a client on instance B', async () => {
    const a = new EventBus();
    const b = new EventBus();
    await sleep();
    const onB = client(b, 'user-1');

    a.publish(event('user-1'), 'user-1');
    await sleep();

    expect(onB).toHaveLength(1);
    expect(onB[0]).toContain('"type":"runtime_state_patch"');
    a.shutdown();
    b.shutdown();
  });

  it('does not deliver the same event twice on the publishing instance', async () => {
    const a = new EventBus();
    await sleep();
    const onA = client(a, 'user-1');

    a.publish(event('user-1'), 'user-1');
    await sleep();

    expect(onA).toHaveLength(1);
    a.shutdown();
  });

  it('keeps events scoped to their user on the remote instance', async () => {
    const a = new EventBus();
    const b = new EventBus();
    await sleep();
    const other = client(b, 'user-2');

    a.publish(event('user-1'), 'user-1');
    await sleep();

    expect(other).toHaveLength(0);
    a.shutdown();
    b.shutdown();
  });

  it('still accepts a bare event from an instance that predates the envelope', async () => {
    const b = new EventBus();
    await sleep();
    const onB = client(b, 'user-1');

    hub.emit('devtrack:sse:events', JSON.stringify(event('user-1')));
    await sleep();

    expect(onB).toHaveLength(1);
    b.shutdown();
  });
});
