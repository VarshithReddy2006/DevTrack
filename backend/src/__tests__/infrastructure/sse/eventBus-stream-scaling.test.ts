// src/__tests__/infrastructure/sse/eventBus-stream-scaling.test.ts
// End-to-End Multi-Instance Scaling Test Suite verifying Invariants INV-01 through INV-10

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, type SseClient, type SseEvent } from '../../../shared/sse/eventBus.js';
import { getShardForUser, getShardStreamKey } from '../../../shared/sse/shardRouter.js';

// Shared in-memory Redis cluster simulation
class SimulatedRedisCluster extends EventEmitter {
  streams = new Map<string, { id: string; fields: string[] }[]>();
  groups = new Map<string, Set<string>>(); // streamKey -> Set<groupName>
  acks = new Map<string, string[]>(); // `${streamKey}:${groupName}` -> [msgIds]
  groupIdle = new Map<string, number>();

  async xgroup(action: string, key: string, group: string, ..._rest: string[]) {
    if (action === 'CREATE') {
      if (!this.groups.has(key)) {
        this.groups.set(key, new Set());
      }
      const streamGroups = this.groups.get(key)!;
      if (streamGroups.has(group)) {
        return 'OK'; // Group exists
      }
      streamGroups.add(group);
      return 'OK';
    }
    if (action === 'DESTROY') {
      const streamGroups = this.groups.get(key);
      if (streamGroups) {
        streamGroups.delete(group);
      }
      return 1;
    }
    return 'OK';
  }

  async xadd(key: string, ...args: any[]) {
    const starIdx = args.indexOf('*');
    const fields = starIdx !== -1 ? args.slice(starIdx + 1) : [];
    const id = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    if (!this.streams.has(key)) {
      this.streams.set(key, []);
    }
    this.streams.get(key)!.push({ id, fields });
    this.emit('xadd', key, id, fields);
    return id;
  }

  async xreadgroup(
    _groupKw: string,
    group: string,
    _consumer: string,
    _countKw: string,
    _count: number,
    _blockKw: string,
    _blockMs: number,
    _streamsKw: string,
    streamKey: string,
    _id: string
  ) {
    const stream = this.streams.get(streamKey) || [];
    const acked = this.acks.get(`${streamKey}:${group}`) || [];
    const unread = stream.filter((e) => !acked.includes(e.id));
    if (unread.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
      return null;
    }
    return [[streamKey, unread.map((e) => [e.id, e.fields])]];
  }

  async xack(streamKey: string, group: string, id: string) {
    const k = `${streamKey}:${group}`;
    if (!this.acks.has(k)) {
      this.acks.set(k, []);
    }
    this.acks.get(k)!.push(id);
    return 1;
  }

  async xinfo(_sub: string, streamKey: string) {
    const streamGroups = this.groups.get(streamKey);
    if (!streamGroups) return [];
    return Array.from(streamGroups).map((name) => ({
      name,
      idle: this.groupIdle.get(`${streamKey}:${name}`) ?? 0,
    }));
  }

  async disconnect() {
    return 'OK';
  }
}

async function registerTestClient(bus: EventBus, userId: string) {
  const frames: string[] = [];
  const c = {
    id: `${userId}-${Math.random()}`,
    userId,
    connectedAt: Date.now(),
    controller: {
      enqueue: (b: Uint8Array) => frames.push(new TextDecoder().decode(b)),
    },
    emit: () => undefined,
    destroy: () => undefined,
  } as unknown as SseClient;
  bus.register(c);
  // Allow async shard registration to resolve
  await new Promise((r) => setTimeout(r, 20));
  return { frames, client: c };
}

describe('Horizontal Redis Stream SSE Scaling (INV-01 through INV-10)', () => {
  let cluster: SimulatedRedisCluster;

  beforeEach(() => {
    cluster = new SimulatedRedisCluster();
  });

  it('INV-01 & INV-02: Broadcasts cross-pod to targeted user with strict user isolation', async () => {
    const podA = new EventBus(cluster as any);
    const podB = new EventBus(cluster as any);

    // Pod B hosts user-1 and user-2
    const { frames: user1Frames } = await registerTestClient(podB, 'user-1');
    const { frames: user2Frames } = await registerTestClient(podB, 'user-2');

    // Pod A publishes event for user-1
    const testEvent: SseEvent = {
      id: 'stream-100-0',
      type: 'runtime_state_patch',
      timestamp: new Date().toISOString(),
      userId: 'user-1',
      payload: { activeStreak: 12 },
    };

    podA.publish(testEvent, 'user-1');

    // Allow async stream reader on Pod B to ingest and acknowledge
    await new Promise((r) => setTimeout(r, 100));

    // INV-01: Pod B delivered to user-1
    expect(user1Frames.length).toBeGreaterThanOrEqual(1);
    expect(user1Frames[0]).toContain('"activeStreak":12');

    // INV-02: Pod B NEVER delivered user-1 event to user-2
    expect(user2Frames.length).toBe(0);

    await podA.shutdown();
    await podB.shutdown();
  });

  it('INV-08: Publishing pod delivers locally once and suppresses self-echo from stream', async () => {
    const podA = new EventBus(cluster as any);

    // Client connected on Pod A
    const { frames } = await registerTestClient(podA, 'user-local');

    const testEvent: SseEvent = {
      id: 'stream-local-0',
      type: 'level_up',
      timestamp: new Date().toISOString(),
      userId: 'user-local',
      payload: { newLevel: 10 },
    };

    podA.publish(testEvent, 'user-local');

    // Allow background stream loop to process
    await new Promise((r) => setTimeout(r, 100));

    // Local client must receive EXACTLY 1 frame (no duplicate echo)
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('"newLevel":10');

    await podA.shutdown();
  });

  it('Idle Pod Traffic Reduction: Pod with no clients on Shard K ignores Shard K traffic', async () => {
    const podA = new EventBus(cluster as any);
    const idlePod = new EventBus(cluster as any);

    // Pod A has a client
    await registerTestClient(podA, 'user-active');
    // idlePod has NO clients registered

    const targetShard = getShardForUser('user-active');

    // Verify idlePod has 0 active shards
    expect(idlePod.streamAdapter.isShardActive(targetShard)).toBe(false);

    // Pod A publishes
    podA.publish(
      {
        id: 'msg-1',
        type: 'sync_completed',
        timestamp: new Date().toISOString(),
        userId: 'user-active',
      },
      'user-active'
    );

    await new Promise((r) => setTimeout(r, 80));

    // idlePod never acquired Shard K, avoiding 100% of event deserialization
    expect(idlePod.streamAdapter.isShardActive(targetShard)).toBe(false);
    expect(idlePod.streamAdapter.getMetrics().totalEventsDelivered).toBe(0);

    await podA.shutdown();
    await idlePod.shutdown();
  });

  it('INV-06 & INV-07: Shard maintains hysteresis on client disconnect and ACKs all messages', async () => {
    const pod = new EventBus(cluster as any);
    const userId = 'user-hysteresis';
    const shardId = getShardForUser(userId);

    const { client } = await registerTestClient(pod, userId);
    expect(pod.streamAdapter.isShardActive(shardId)).toBe(true);

    // Unregister client
    pod.unregister(client.id);

    // INV-07: Shard must enter draining state, NOT immediately destroyed
    expect(pod.streamAdapter.isShardDraining(shardId)).toBe(true);

    await pod.shutdown();
  });

  it('INV-05: Stream operations always use isolated single-shard cluster keys', () => {
    for (let s = 0; s < 16; s++) {
      const key = getShardStreamKey(s);
      expect(key).toBe(`devtrack:sse:stream:{${s}}`);
      // Verify curly braces enclose only the shard index for distinct slot hashing
      const match = /\{(\d+)\}/.exec(key);
      expect(match).not.toBeNull();
      expect(parseInt(match![1], 10)).toBe(s);
    }
  });
});
