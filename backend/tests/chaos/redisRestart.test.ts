// tests/chaos/redisRestart.test.ts — Chaos: Redis crash/restart while 120 SSE clients are connected.
//
// Real code under test: EventBus.publishEnvelope (stream buffer + in-memory fallback),
// handleSseRequest / replayMissedEvents (Last-Event-ID backfill) and the ticket store.
// Only Redis is fake (FakeRedis), and time is driven by vitest fake timers, so the
// scenario is deterministic and needs no Redis or network.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRedis } from './helpers/fakeRedis.js';
import { connectSse, settle, type SseConnection } from './helpers/sseHarness.js';

const redis = new FakeRedis();

vi.mock('../../src/shared/redis/client.js', () => ({
  getRedisClient: () => redis,
  getRedisHealth: () => ({ status: redis.health }),
  isRedisConfigured: () => false,
  createRedisConnection: vi.fn(),
}));

vi.mock('../../src/modules/runtime-state/unifiedRuntimeState.service.js', () => {
  const mockState = {
    level: 7,
    xp: 700,
    lastCalculatedAt: '2026-01-01T00:00:00.000Z',
    sessionContext: {},
    toObject: () => ({ level: 7, totalXp: 700 }),
  };
  return {
    unifiedRuntimeStateService: {
      getRuntimeState: vi.fn(async () => mockState),
      getRuntimeStateFresh: vi.fn(async () => mockState),
    },
  };
});

import { eventBus } from '../../src/shared/sse/eventBus.js';

const USERS = Array.from({ length: 12 }, (_, i) => `user-${i}`);
const CLIENTS_PER_USER = 10; // 120 subscribers in total
const STREAM_ID = /^\d+-\d+$/;

async function publish(userId: string, marker: string): Promise<void> {
  await vi.advanceTimersByTimeAsync(2); // distinct millisecond per event, like real traffic
  await eventBus.publishEnvelope(userId, 'runtime_state_patch', { marker });
  await settle();
}

const eventFrames = (conn: SseConnection) =>
  conn.dataFrames().filter((f) => f.data?.type !== 'runtime_state_full');
const markers = (conn: SseConnection) => eventFrames(conn).map((f) => f.data?.payload?.marker);

describe('Chaos: Redis restart with 120 SSE subscribers', () => {
  let connections: SseConnection[];

  beforeAll(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
  });

  afterAll(() => {
    eventBus.shutdown();
    vi.useRealTimers();
  });

  beforeEach(async () => {
    redis.restart({ persist: false });
    redis.acceptCommands();
    connections = [];
    for (const userId of USERS) {
      for (let i = 0; i < CLIENTS_PER_USER; i++) connections.push(await connectSse(userId));
    }
  });

  afterEach(() => {
    connections.forEach((c) => c.disconnect());
    redis.restart({ persist: false });
  });

  it('keeps every subscriber connected and delivering through a crash and a persistent restart', async () => {
    expect(connections.every((c) => c.status === 200)).toBe(true);
    expect(eventBus.getMetrics().activeConnections).toBe(USERS.length * CLIENTS_PER_USER);

    for (const userId of USERS) {
      await publish(userId, 'before-1');
      await publish(userId, 'before-2');
    }

    redis.crash();
    for (const userId of USERS) {
      // publishEnvelope must degrade to in-memory delivery, not throw
      await expect(publish(userId, 'outage-1')).resolves.toBeUndefined();
    }

    // The ticket handshake also has to work while Redis is away (memory fallback)
    const lateJoiner = await connectSse('user-0');
    expect(lateJoiner.status).toBe(200);
    connections.push(lateJoiner);

    redis.restart({ persist: true });
    for (const userId of USERS) await publish(userId, 'after-1');

    for (const conn of connections.slice(0, -1)) {
      expect(markers(conn)).toEqual(['before-1', 'before-2', 'outage-1', 'after-1']);
    }
    // The late joiner only saw what happened after it connected (it asked for no backlog)
    expect(markers(lateJoiner)).toEqual(['after-1']);
    // No leak, nobody was dropped by the outage
    expect(eventBus.getMetrics().activeConnections).toBe(USERS.length * CLIENTS_PER_USER + 1);

    // Live events that were buffered carry real stream ids; fallback ones carry a marker id.
    const ids = eventFrames(connections[0]).map((f) => f.id!);
    expect(ids[0]).toMatch(STREAM_ID);
    expect(ids[1]).toMatch(STREAM_ID);
    expect(ids[2]).toContain('-fallback-');
    expect(ids[3]).toMatch(STREAM_ID);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate delivery
  });

  it('replays exactly the missed events, in order, when Redis kept its data across the restart', async () => {
    const [victim] = connections;
    await publish(victim.userId, 'seen-1');
    await publish(victim.userId, 'seen-2');
    const resumeFrom = victim.lastEventId()!;
    victim.disconnect();

    await publish(victim.userId, 'missed-1');
    await publish(victim.userId, 'missed-2');

    redis.crash();
    redis.restart({ persist: true });

    const resumed = await connectSse(victim.userId, resumeFrom);
    connections.push(resumed);

    expect(markers(resumed)).toEqual(['missed-1', 'missed-2']);
    expect(resumed.dataFrames().map((f) => f.id)).toEqual(
      [...resumed.dataFrames().map((f) => f.id)].sort((a, b) => {
        const [am, as] = a!.split('-').map(Number);
        const [bm, bs] = b!.split('-').map(Number);
        return am - bm || as - bs;
      }),
    );
    expect(resumed.dataFrames().every((f) => f.id !== resumeFrom)).toBe(true); // strictly after
  });

  it('falls back to a full runtime-state resync when Redis restarts empty', async () => {
    const [victim] = connections;
    await publish(victim.userId, 'seen-1');
    const resumeFrom = victim.lastEventId()!;
    victim.disconnect();
    await publish(victim.userId, 'missed-1');

    redis.crash();
    redis.restart({ persist: false }); // stream and sequence counters are gone

    const resumed = await connectSse(victim.userId, resumeFrom);
    connections.push(resumed);

    expect(resumed.status).toBe(200);
    const [first] = resumed.dataFrames();
    expect(first.data?.type).toBe('runtime_state_full');
    expect(first.data?.payload).toEqual({ state: { level: 7, totalXp: 700 } });

    // And the bus keeps working on the wiped keyspace
    await publish(victim.userId, 'fresh-1');
    expect(markers(resumed).at(-1)).toBe('fresh-1');
    expect(resumed.lastEventId()).toMatch(STREAM_ID);
  });

  it('resyncs a client whose last id is an outage fallback id instead of leaving it silent', async () => {
    const [victim] = connections;
    redis.crash();
    await publish(victim.userId, 'outage-1');
    const resumeFrom = victim.lastEventId()!;
    expect(resumeFrom).toContain('-fallback-');
    victim.disconnect();
    redis.restart({ persist: true });
    await publish(victim.userId, 'after-1');

    const resumed = await connectSse(victim.userId, resumeFrom);
    connections.push(resumed);

    expect(resumed.dataFrames()[0].data?.type).toBe('runtime_state_full');
  });

  // KNOWN GAP (reported in the PR): events published while Redis is down are delivered
  // live but never written to the stream. A client that was offline during the outage and
  // reconnects with its last pre-outage stream id gets only the events stored after Redis
  // came back, with no full-state resync, so the outage-window events are lost silently.
  // `it.fails` keeps CI green while the gap exists and turns red once it is fixed, which
  // is the cue to flip this to a plain `it`.
  it.fails('does not silently lose events published during the outage window', async () => {
    const [victim] = connections;
    await publish(victim.userId, 'seen-1');
    const resumeFrom = victim.lastEventId()!;
    victim.disconnect();

    redis.crash();
    await publish(victim.userId, 'outage-1');
    await publish(victim.userId, 'outage-2');
    redis.restart({ persist: true });
    await publish(victim.userId, 'after-1');

    const resumed = await connectSse(victim.userId, resumeFrom);
    connections.push(resumed);

    const gotAllEvents = ['outage-1', 'outage-2', 'after-1'].every((m) => markers(resumed).includes(m));
    const gotFullResync = resumed.dataFrames().some((f) => f.data?.type === 'runtime_state_full');
    expect(gotAllEvents || gotFullResync).toBe(true);
  });

  // KNOWN GAP: Redis refusing writes while the connection reports ready (MISCONF after a
  // failed RDB save, OOM under noeviction, READONLY replica). publishEnvelope throws on
  // `redis.incr` before it reaches the in-memory publish, so clients that are connected
  // right now miss the event even though the local fan-out path is perfectly healthy.
  it.fails('still delivers live events to connected clients when Redis refuses commands', async () => {
    const [client] = connections;
    redis.refuseCommands(new Error('MISCONF Redis is configured to save RDB snapshots'));

    await publish(client.userId, 'while-misconf').catch(() => undefined);

    expect(markers(client)).toContain('while-misconf');
  });
});
