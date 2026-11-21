// src/__tests__/shared/sse/redisStreamAdapter.test.ts
// Unit tests for RedisStreamAdapter lifecycle, hysteresis debouncing, shard routing, and XACK

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RedisStreamAdapter } from '../../../shared/sse/redisStreamAdapter.js';
import { getShardForUser, getShardStreamKey } from '../../../shared/sse/shardRouter.js';

interface FakeStreamEntry {
  id: string;
  fields: string[];
}

class FakeRedisStreamServer extends EventEmitter {
  streams = new Map<string, FakeStreamEntry[]>();
  groups = new Map<string, Set<string>>(); // streamKey -> Set<groupName>
  groupIdle = new Map<string, number>(); // `${streamKey}:${groupName}` -> idleMs
  acks = new Map<string, string[]>(); // `${streamKey}:${groupName}` -> [msgIds]

  xgroupCalls: { action: string; key: string; group: string }[] = [];
  xaddCalls: { key: string; fields: any[] }[] = [];
  xackCalls: { key: string; group: string; id: string }[] = [];

  async xgroup(action: string, key: string, group: string, ...rest: string[]) {
    this.xgroupCalls.push({ action, key, group });
    if (action === 'CREATE') {
      if (!this.groups.has(key)) {
        this.groups.set(key, new Set());
      }
      const streamGroups = this.groups.get(key)!;
      if (streamGroups.has(group)) {
        throw new Error('BUSYGROUP Consumer Group name already exists');
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
    this.xaddCalls.push({ key, fields: args });
    const id = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    if (!this.streams.has(key)) {
      this.streams.set(key, []);
    }
    // args format: 'MAXLEN', '~', 10000, '*', key1, val1, key2, val2...
    const starIdx = args.indexOf('*');
    const fields = starIdx !== -1 ? args.slice(starIdx + 1) : [];
    this.streams.get(key)!.push({ id, fields });
    this.emit('entry_added', key, id, fields);
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
    this.xackCalls.push({ key: streamKey, group, id });
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

describe('RedisStreamAdapter Core & Sharding', () => {
  let fakeRedis: FakeRedisStreamServer;
  let adapter: RedisStreamAdapter;

  beforeEach(() => {
    fakeRedis = new FakeRedisStreamServer();
    adapter = new RedisStreamAdapter(
      'instance-test-1',
      {
        numShards: 16,
        hysteresisMs: 50, // Short 50ms hysteresis for test speed
        blockMs: 20,
      },
      fakeRedis as any
    );
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('initializes with instance-scoped consumer group and inactive shards', () => {
    expect(adapter.instanceId).toBe('instance-test-1');
    expect(adapter.groupName).toBe('devtrack:sse:pod:instance-test-1');
    const metrics = adapter.getMetrics();
    expect(metrics.activeShards).toBe(0);
    expect(metrics.totalSubscribedUsers).toBe(0);
  });

  it('creates consumer group on Redis when acquiring a shard', async () => {
    await adapter.acquireShard(3);
    expect(adapter.isShardActive(3)).toBe(true);

    const streamKey = getShardStreamKey(3);
    const createCall = fakeRedis.xgroupCalls.find(
      (c) => c.action === 'CREATE' && c.key === streamKey
    );
    expect(createCall).toBeDefined();
    expect(createCall?.group).toBe('devtrack:sse:pod:instance-test-1');
  });

  it('increments refCount on multiple acquires for the same shard', async () => {
    await adapter.acquireShard(5);
    await adapter.acquireShard(5);
    const metrics = adapter.getMetrics();
    const s5 = metrics.shards.find((s) => s.shardId === 5);
    expect(s5?.refCount).toBe(2);
    expect(s5?.status).toBe('active');
  });

  it('enters draining state under hysteresis when refCount reaches 0', async () => {
    await adapter.acquireShard(2);
    adapter.releaseShard(2);

    expect(adapter.isShardDraining(2)).toBe(true);
    // Consumer group should NOT be destroyed yet
    const streamKey = getShardStreamKey(2);
    const destroyCall = fakeRedis.xgroupCalls.find(
      (c) => c.action === 'DESTROY' && c.key === streamKey
    );
    expect(destroyCall).toBeUndefined();
  });

  it('cancels hysteresis drain and resumes active status if re-acquired in time', async () => {
    await adapter.acquireShard(2);
    adapter.releaseShard(2);
    expect(adapter.isShardDraining(2)).toBe(true);

    // Re-acquire before 50ms expires
    await adapter.acquireShard(2);
    expect(adapter.isShardActive(2)).toBe(true);
    expect(adapter.isShardDraining(2)).toBe(false);

    // Wait past the original 50ms timer
    await new Promise((r) => setTimeout(r, 70));
    expect(adapter.isShardActive(2)).toBe(true);
    // Group was never destroyed
    const streamKey = getShardStreamKey(2);
    const destroyCall = fakeRedis.xgroupCalls.find(
      (c) => c.action === 'DESTROY' && c.key === streamKey
    );
    expect(destroyCall).toBeUndefined();
  });

  it('destroys consumer group when hysteresis expires without re-acquisition', async () => {
    await adapter.acquireShard(4);
    adapter.releaseShard(4);
    expect(adapter.isShardDraining(4)).toBe(true);

    // Wait for 50ms hysteresis timer to expire
    await new Promise((r) => setTimeout(r, 80));

    expect(adapter.isShardActive(4)).toBe(false);
    expect(adapter.isShardDraining(4)).toBe(false);

    const streamKey = getShardStreamKey(4);
    const destroyCall = fakeRedis.xgroupCalls.find(
      (c) => c.action === 'DESTROY' && c.key === streamKey
    );
    expect(destroyCall).toBeDefined();
  });

  it('transitions to draining and arms hysteresis when client disconnects while shard activation is in-flight (F-01)', async () => {
    // Shard 5 starts inactive
    expect(adapter.isShardActive(5)).toBe(false);
    expect(adapter.isShardDraining(5)).toBe(false);

    // Client begins acquisition (async XGROUP CREATE is in-flight)
    const activationPromise = adapter.acquireShard(5);

    // Client disconnects before activation completes (refCount hits 0 while activating)
    adapter.releaseShard(5);

    // Await activation completion
    await activationPromise;

    // Must transition directly to draining rather than remaining active with 0 subscribers
    expect(adapter.isShardActive(5)).toBe(false);
    expect(adapter.isShardDraining(5)).toBe(true);

    // Wait past hysteresis timer (50ms in test harness)
    await new Promise((r) => setTimeout(r, 80));

    // Shard should now be cleanly deactivated
    expect(adapter.isShardActive(5)).toBe(false);
    expect(adapter.isShardDraining(5)).toBe(false);

    const streamKey = getShardStreamKey(5);
    const destroyCall = fakeRedis.xgroupCalls.find(
      (c) => c.action === 'DESTROY' && c.key === streamKey
    );
    expect(destroyCall).toBeDefined();
  });

  it('remains active without draining if another client connects while shard activation is in-flight (F-01)', async () => {
    // Shard 6 starts inactive
    expect(adapter.isShardActive(6)).toBe(false);

    // Client 1 begins acquisition
    const p1 = adapter.acquireShard(6);

    // Client 1 disconnects
    adapter.releaseShard(6);

    // Client 2 connects while activation is still in-flight
    const p2 = adapter.acquireShard(6);

    await Promise.all([p1, p2]);

    // Shard should be active because refCount is 1
    expect(adapter.isShardActive(6)).toBe(true);
    expect(adapter.isShardDraining(6)).toBe(false);
  });

  it('routes user registration and unregistration to correct shard', async () => {
    const userId = 'usr_prod_alpha_99';
    const expectedShard = getShardForUser(userId);

    const assignedShard = await adapter.registerUser(userId);
    expect(assignedShard).toBe(expectedShard);
    expect(adapter.isShardActive(expectedShard)).toBe(true);

    const unregShard = adapter.unregisterUser(userId);
    expect(unregShard).toBe(expectedShard);
    expect(adapter.isShardDraining(expectedShard)).toBe(true);
  });

  it('publishes events to correct shard stream with bounded MAXLEN ~ 10000', async () => {
    const event = {
      origin: 'instance-test-1',
      userId: 'usr_prod_delta_100',
      type: 'runtime_state_patch' as const,
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: { xpDelta: 50 },
    };

    const targetShard = getShardForUser(event.userId);
    const streamKey = getShardStreamKey(targetShard);

    const streamId = await adapter.publishEvent(event);
    expect(streamId).toBeDefined();

    const addCall = fakeRedis.xaddCalls.find((c) => c.key === streamKey);
    expect(addCall).toBeDefined();
    expect(addCall?.fields[0]).toBe('MAXLEN');
    expect(addCall?.fields[1]).toBe('~');
    expect(addCall?.fields[2]).toBe(10_000);
  });

  it('reads messages from shard and sends immediate XACK for bounded PEL', async () => {
    const userId = 'user_read_test_1';
    const shard = await adapter.registerUser(userId);
    const streamKey = getShardStreamKey(shard);

    const messagePromise = new Promise<{ event: any; msgId: string }>((resolve) => {
      adapter.once('message', (ev, id) => resolve({ event: ev, msgId: id }));
    });

    // Add entry to Redis stream
    const addedId = await fakeRedis.xadd(
      streamKey,
      'MAXLEN',
      '~',
      10000,
      '*',
      'origin',
      'peer-instance-2',
      'userId',
      userId,
      'type',
      'level_up',
      'sequence',
      '1',
      'payload',
      JSON.stringify({ newLevel: 5 }),
      'timestamp',
      new Date().toISOString()
    );

    const received = await messagePromise;
    expect(received.event.userId).toBe(userId);
    expect(received.event.type).toBe('level_up');
    expect(received.event.payload).toEqual({ newLevel: 5 });

    // Verify XACK was invoked for received message ID
    await new Promise((r) => setTimeout(r, 20));
    const ackCall = fakeRedis.xackCalls.find(
      (c) => c.key === streamKey && c.id === addedId
    );
    expect(ackCall).toBeDefined();
  });

  it('secondary GC prunes only groups idle > 24 hours (INV-09)', async () => {
    const streamKey = getShardStreamKey(1);
    // Setup stale group (idle 25 hours = 90,000,000 ms)
    fakeRedis.groups.set(
      streamKey,
      new Set(['devtrack:sse:pod:stale-crashed-pod-1', 'devtrack:sse:pod:active-peer'])
    );
    fakeRedis.groupIdle.set(
      `${streamKey}:devtrack:sse:pod:stale-crashed-pod-1`,
      90_000_000
    );
    fakeRedis.groupIdle.set(
      `${streamKey}:devtrack:sse:pod:active-peer`,
      30_000 // Only 30s idle
    );

    const cleaned = await adapter.cleanupStaleConsumerGroups(86_400_000);
    expect(cleaned).toBe(1);

    const remaining = fakeRedis.groups.get(streamKey);
    expect(remaining?.has('devtrack:sse:pod:stale-crashed-pod-1')).toBe(false);
    expect(remaining?.has('devtrack:sse:pod:active-peer')).toBe(true);
  });
});
