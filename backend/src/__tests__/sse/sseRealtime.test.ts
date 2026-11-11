import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redis = {
  incr: vi.fn(async () => 1),
  expire: vi.fn(async () => 1),
  xtrim: vi.fn(async () => 0),
  xadd: vi.fn(async () => '1700000000000-0'),
  xrange: vi.fn(async (): Promise<unknown[]> => []),
};

vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => redis,
  getRedisHealth: () => ({ status: 'connected' }),
  isRedisConfigured: () => false,
  createRedisConnection: vi.fn(),
}));

vi.mock('../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: { getRuntimeState: vi.fn(async () => null) },
}));

import { EventBus } from '../../shared/sse/eventBus.js';
import { parseStreamId, replayMissedEvents } from '../../shared/sse/sseHandler.js';

function published(bus: EventBus) {
  const spy = vi.spyOn(bus, 'publishEnvelope').mockResolvedValue(undefined);
  return spy;
}

describe('runtime_state_patch coalescing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps one buffer per user, so concurrent users do not overwrite each other', async () => {
    const bus = new EventBus();
    const spy = published(bus);

    await bus.emitRuntimeStatePatch('user-a', { a: 1 });
    await bus.emitRuntimeStatePatch('user-b', { b: 2 });
    await bus.emitRuntimeStatePatch('user-a', { a2: 3 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('user-a', 'runtime_state_patch', { a: 1, a2: 3 });
    expect(spy).toHaveBeenCalledWith('user-b', 'runtime_state_patch', { b: 2 });
    bus.shutdown();
  });

  it('starts a fresh window after a flush', async () => {
    const bus = new EventBus();
    const spy = published(bus);

    await bus.emitRuntimeStatePatch('user-a', { n: 1 });
    await vi.advanceTimersByTimeAsync(3000);
    await bus.emitRuntimeStatePatch('user-a', { n: 2 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(spy.mock.calls.map((c) => c[2])).toEqual([{ n: 1 }, { n: 2 }]);
    bus.shutdown();
  });

  it('shutdown clears pending timers so nothing publishes afterwards', async () => {
    const bus = new EventBus();
    const spy = published(bus);

    await bus.emitRuntimeStatePatch('user-a', { a: 1 });
    await bus.emitRuntimeStatePatch('user-b', { b: 1 });
    bus.shutdown();
    await vi.advanceTimersByTimeAsync(10000);

    expect(spy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('live event ids', () => {
  it('publishes the Redis Stream id the entry was stored under', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('event', (e: { id: string }) => seen.push(e.id));
    const publish = vi.spyOn(bus, 'publish').mockImplementation(() => undefined);

    redis.xadd.mockResolvedValueOnce('1700000000123-2');
    await bus.publishEnvelope('user-with-dashes', 'runtime_state_patch', { a: 1 });

    expect(publish.mock.calls[0][0].id).toBe('1700000000123-2');
    bus.shutdown();
  });
});

describe('parseStreamId', () => {
  it.each([
    ['1700000000000-0', '1700000000000-0'],
    ['1700000000000-1', '1700000000000-1'],
    ['1700000000000-2', '1700000000000-2'],
    [' 5-7 ', '5-7'],
  ])('accepts %s', (input, expected) => {
    expect(parseStreamId(input)).toBe(expected);
  });

  it.each(['', undefined, 'abc', 'user-1-2', 'user-with-dash-5-1700', '123', '123-', '-5', '1-2-3', '1.5-2'])(
    'rejects %s',
    (input) => {
      expect(parseStreamId(input as string | undefined)).toBeNull();
    },
  );
});

describe('replayMissedEvents', () => {
  const entry = (id: string, seq: number): [string, string[]] => [
    id,
    ['type', 'runtime_state_patch', 'sequence', String(seq), 'payload', '{"x":1}', 'timestamp', 't'],
  ];

  function controller() {
    const chunks: string[] = [];
    const ctl = { enqueue: (b: Uint8Array) => chunks.push(new TextDecoder().decode(b)) };
    return { ctl: ctl as unknown as ReadableStreamDefaultController<Uint8Array>, chunks };
  }

  beforeEach(() => redis.xrange.mockClear());

  it.each(['1700000000000-0', '1700000000000-1', '1700000000000-2'])(
    'asks Redis for entries strictly after %s',
    async (lastId) => {
      redis.xrange.mockResolvedValueOnce([entry('1700000000001-0', 4)]);
      const { ctl, chunks } = controller();

      await replayMissedEvents('user-with-dashes', lastId, ctl);

      expect(redis.xrange).toHaveBeenCalledWith('sse:stream:user-with-dashes', `(${lastId}`, '+', 'COUNT', 50);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('id: 1700000000001-0');
    },
  );

  it('replays several events from the same millisecond in order', async () => {
    redis.xrange.mockResolvedValueOnce([entry('1700000000000-1', 2), entry('1700000000000-2', 3)]);
    const { ctl, chunks } = controller();

    await replayMissedEvents('u', '1700000000000-0', ctl);

    expect(chunks.map((c) => c.split('\n')[0])).toEqual(['id: 1700000000000-1', 'id: 1700000000000-2']);
  });

  it.each(['garbage', 'u-1-1700000000000', 'NaN-1'])('does not query Redis for malformed id %s', async (bad) => {
    const { ctl, chunks } = controller();

    await replayMissedEvents('u', bad, ctl);

    expect(redis.xrange).not.toHaveBeenCalled();
    expect(chunks).toHaveLength(0);
  });
});
