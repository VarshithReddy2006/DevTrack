// Last-Event-ID replay: paging through the Redis stream, the gap cap, and the window between
// reading the stream and registering the client. Redis is an in-memory fake that honours
// XRANGE's exclusive "(" start and COUNT, and the event bus is a stub, so nothing real is touched.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Entry = [string, string[]];

const fixture = vi.hoisted(() => ({
  stream: [] as [string, string[]][],
  xrangeCalls: [] as unknown[][],
  order: [] as string[],
  clients: [] as { controller: { enqueue(chunk: Uint8Array): void } }[],
  onRead: null as null | (() => void),
  state: { toObject: () => ({ level: 7 }) } as { toObject: () => unknown } | null,
}));

vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => ({
    // Same contract as Redis: entries after the id (exclusive when it starts with "("), at most COUNT.
    async xrange(_key: string, start: string, _end: string, _count: string, count: number) {
      fixture.order.push('xrange');
      fixture.xrangeCalls.push([start, count]);
      const after = start.slice(1);
      const afterSeq = Number(after.split('-')[1]);
      const page = fixture.stream.filter(([id]) => Number(id.split('-')[1]) > afterSeq).slice(0, count);
      fixture.onRead?.();
      return page;
    },
  }),
}));
vi.mock('../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../shared/monitoring.js', () => ({
  trackSseConnectionSuccess: vi.fn(),
  trackSseConnectionFailure: vi.fn(),
  trackSseDisconnection: vi.fn(),
}));
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../shared/sse/eventBus.js', () => ({
  eventBus: {
    register: (client: (typeof fixture.clients)[number]) => {
      fixture.order.push('register');
      fixture.clients.push(client);
    },
    unregister: vi.fn(),
  },
}));
vi.mock('../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: { getRuntimeState: vi.fn(async () => fixture.state) },
}));

import { createSseStream, MAX_REPLAY_EVENTS, replayMissedEvents } from '../../shared/sse/sseHandler.js';

const id = (n: number) => `1000-${n}`;
const entry = (n: number): Entry => [
  id(n),
  ['type', 'xp_updated', 'sequence', String(n), 'payload', '{"n":' + n + '}', 'timestamp', 't'],
];
const seedStream = (count: number) => {
  fixture.stream = Array.from({ length: count }, (_, i) => entry(i + 1));
};

function controller() {
  const chunks: string[] = [];
  const ctl = { enqueue: (b: Uint8Array) => chunks.push(new TextDecoder().decode(b)) };
  return { ctl: ctl as unknown as ReadableStreamDefaultController<Uint8Array>, chunks };
}
const ids = (chunks: string[]) => chunks.map((c) => /^id: (.*)$/m.exec(c)![1]);
const fullStateSent = (chunks: string[]) => chunks.some((c) => c.includes('"type":"runtime_state_full"'));

beforeEach(() => {
  fixture.stream = [];
  fixture.xrangeCalls = [];
  fixture.order = [];
  fixture.clients = [];
  fixture.onRead = null;
  fixture.state = { toObject: () => ({ level: 7 }) };
});

describe('replayMissedEvents paging', () => {
  it('replays every event when the client missed more than one page', async () => {
    seedStream(75);
    const { ctl, chunks } = controller();

    const replayed = await replayMissedEvents('u1', id(0), ctl);

    expect(ids(chunks)).toEqual(Array.from({ length: 75 }, (_, i) => id(i + 1)));
    expect(fullStateSent(chunks)).toBe(false);
    expect([...replayed]).toEqual(ids(chunks));
    // Second page starts after the last entry of the first one, never repeating it.
    expect(fixture.xrangeCalls).toEqual([
      ['(1000-0', 50],
      ['(1000-50', 50],
    ]);
  });

  it('keeps the single-read behaviour for up to one page', async () => {
    seedStream(3);
    const { ctl, chunks } = controller();

    await replayMissedEvents('u1', id(0), ctl);

    expect(ids(chunks)).toEqual([id(1), id(2), id(3)]);
    expect(fixture.xrangeCalls).toEqual([['(1000-0', 50]]);
  });

  it('replays an exact page of 50 and stops on the empty follow-up page', async () => {
    seedStream(50);
    const { ctl, chunks } = controller();

    await replayMissedEvents('u1', id(0), ctl);

    expect(chunks).toHaveLength(50);
    expect(new Set(ids(chunks)).size).toBe(50);
    expect(fixture.xrangeCalls).toHaveLength(2);
  });

  it('replays exactly MAX_REPLAY_EVENTS events without falling back to full state', async () => {
    seedStream(MAX_REPLAY_EVENTS);
    const { ctl, chunks } = controller();

    await replayMissedEvents('u1', id(0), ctl);

    expect(chunks).toHaveLength(MAX_REPLAY_EVENTS);
    expect(fullStateSent(chunks)).toBe(false);
  });

  it('sends full state instead of a partial replay when the gap is bigger than the cap', async () => {
    seedStream(120);
    const { ctl, chunks } = controller();

    const replayed = await replayMissedEvents('u1', id(0), ctl);

    expect(chunks).toHaveLength(1);
    expect(fullStateSent(chunks)).toBe(true);
    expect(chunks[0]).toContain('"state":{"level":7}');
    expect(replayed.size).toBe(0);
    // Reading stops as soon as the cap is exceeded instead of draining a huge stream.
    expect(fixture.xrangeCalls).toHaveLength(3);
  });

  it('does not replay events at or before Last-Event-ID', async () => {
    seedStream(80);
    const { ctl, chunks } = controller();

    await replayMissedEvents('u1', id(60), ctl);

    expect(ids(chunks)).toEqual(Array.from({ length: 20 }, (_, i) => id(61 + i)));
  });

  it('still sends full state when the stream has nothing after Last-Event-ID', async () => {
    seedStream(5);
    const { ctl, chunks } = controller();

    await replayMissedEvents('u1', id(5), ctl);

    expect(fullStateSent(chunks)).toBe(true);
    expect(chunks).toHaveLength(1);
  });

  it('still sends full state for a malformed Last-Event-ID without querying Redis', async () => {
    seedStream(5);
    const { ctl, chunks } = controller();

    await replayMissedEvents('u1', 'u1-3-1700000000000', ctl);

    expect(fixture.xrangeCalls).toHaveLength(0);
    expect(fullStateSent(chunks)).toBe(true);
  });
});

describe('createSseStream reconnect', () => {
  const text = (chunk: Uint8Array | undefined) => new TextDecoder().decode(chunk);
  /** What the event bus does for a live event: write straight to the registered client's controller. */
  const publishLive = (liveId: string) => {
    fixture.clients[0].controller.enqueue(new TextEncoder().encode(`id: ${liveId}\ndata: {"live":"${liveId}"}\n\n`));
  };

  async function readChunks(stream: ReadableStream<Uint8Array>, count: number) {
    const reader = stream.getReader();
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(text((await reader.read()).value));
    return { reader, out };
  }

  it('registers the client before reading the stream', async () => {
    seedStream(2);
    const stream = createSseStream('u1', 'c1', 'r1', id(0));
    const { reader } = await readChunks(stream, 2);
    await reader.cancel();

    expect(fixture.order).toEqual(['register', 'xrange']);
  });

  it('delivers an event published during the stream read, after the replay and only once', async () => {
    seedStream(3);
    // Published after the XRANGE read, before the old code would have registered the client.
    fixture.onRead = () => {
      fixture.onRead = null;
      publishLive('1000-4');
    };
    const stream = createSseStream('u1', 'c1', 'r1', id(0));

    const { reader, out } = await readChunks(stream, 4);
    expect(out.map((c) => /^id: (.*)$/m.exec(c)![1])).toEqual([id(1), id(2), id(3), id(4)]);

    // Live events after the replay go straight through.
    publishLive('1000-5');
    expect(text((await reader.read()).value)).toContain('id: 1000-5');
    await reader.cancel();
  });

  it('drops the live copy of an event the replay already sent', async () => {
    seedStream(3);
    // Event 3 was written to the stream before the read, but its live publish lands during it.
    fixture.onRead = () => {
      fixture.onRead = null;
      publishLive(id(3));
    };
    const stream = createSseStream('u1', 'c1', 'r1', id(0));

    const { reader, out } = await readChunks(stream, 3);
    expect(out.map((c) => /^id: (.*)$/m.exec(c)![1])).toEqual([id(1), id(2), id(3)]);

    publishLive('1000-4');
    const next = text((await reader.read()).value);
    expect(next).toContain('id: 1000-4');
    await reader.cancel();
  });

  it('connects without Last-Event-ID the same as before: no read, live events pass through', async () => {
    const stream = createSseStream('u1', 'c1', 'r1');
    const reader = stream.getReader();
    // start() has not necessarily finished; a live write must reach the reader either way.
    await vi.waitFor(() => expect(fixture.clients).toHaveLength(1));
    publishLive('1000-1');

    expect(text((await reader.read()).value)).toContain('id: 1000-1');
    expect(fixture.xrangeCalls).toHaveLength(0);
    await reader.cancel();
  });
});
