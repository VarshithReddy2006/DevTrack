import { describe, expect, it, vi } from 'vitest';
import { createRedisScoreStore } from '../../../modules/leagues/scoreStore.js';
import { FakeScoreStore } from './fakeScoreStore.js';

// The Redis adapter is exercised against a stub client that records commands. No Redis server is involved.
function stubClient() {
  const pipeline = { del: vi.fn().mockReturnThis(), zadd: vi.fn().mockReturnThis(), exec: vi.fn().mockResolvedValue([]) };
  return {
    pipeline,
    client: {
      eval: vi.fn(),
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      zrevrange: vi.fn(),
      exists: vi.fn(),
      expire: vi.fn().mockResolvedValue(1),
      multi: vi.fn().mockReturnValue(pipeline),
    },
  };
}

describe('createRedisScoreStore', () => {
  it('increments through one atomic script and returns the new score', async () => {
    const { client } = stubClient();
    client.eval.mockResolvedValue('75');
    const store = createRedisScoreStore(client as never);

    const score = await store.incrementOnce('league:2026-11-15:gold:c1', 'u1', 25, { setKey: 'league:2026-11-15:applied', id: 'u1|dsa|p1' });

    expect(score).toBe(75);
    const args = client.eval.mock.calls[0];
    expect(args[0]).toContain('ZINCRBY');
    expect(args[0]).toContain('SADD');
    expect(args.slice(1, 7)).toEqual([2, 'league:2026-11-15:gold:c1', 'league:2026-11-15:applied', '25', 'u1|dsa|p1', expect.any(String)]);
    expect(args[7]).toBe('u1');
  });

  it('reports an already applied award as null', async () => {
    const { client } = stubClient();
    client.eval.mockResolvedValue(null);
    const store = createRedisScoreStore(client as never);
    expect(await store.incrementOnce('k', 'u1', 5, { setKey: 's', id: 'i' })).toBeNull();
  });

  it('reads ZREVRANGE WITHSCORES into entries', async () => {
    const { client } = stubClient();
    client.zrevrange.mockResolvedValue(['u2', '90', 'u1', '40']);
    const store = createRedisScoreStore(client as never);
    expect(await store.ranked('k', 0, -1)).toEqual([{ member: 'u2', score: 90 }, { member: 'u1', score: 40 }]);
    expect(client.zrevrange).toHaveBeenCalledWith('k', 0, -1, 'WITHSCORES');
  });

  it('seeds with ZADD NX so existing scores are untouched', async () => {
    const { client } = stubClient();
    const store = createRedisScoreStore(client as never);
    await store.seed('k', ['a', 'b']);
    expect(client.zadd).toHaveBeenCalledWith('k', 'NX', 0, 'a', 0, 'b');
    await store.seed('k', []);
    expect(client.zadd).toHaveBeenCalledTimes(1);
  });

  it('replaces a set in one transaction', async () => {
    const { client, pipeline } = stubClient();
    const store = createRedisScoreStore(client as never);
    await store.replace('k', [{ member: 'a', score: 3 }, { member: 'b', score: 0 }]);
    expect(pipeline.del).toHaveBeenCalledWith('k');
    expect(pipeline.zadd).toHaveBeenCalledWith('k', 3, 'a', 0, 'b');
    expect(pipeline.exec).toHaveBeenCalledOnce();
  });

  it('maps exists, remove, removeMany and expire to their Redis commands', async () => {
    const { client } = stubClient();
    client.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const store = createRedisScoreStore(client as never);
    expect(await store.exists('k')).toBe(true);
    expect(await store.exists('k')).toBe(false);
    await store.remove('k', 'a');
    await store.removeMany('k', ['b', 'c']);
    await store.removeMany('k', []);
    await store.expire('k', 60);
    expect(client.zrem).toHaveBeenCalledWith('k', 'a');
    expect(client.zrem).toHaveBeenCalledWith('k', 'b', 'c');
    expect(client.zrem).toHaveBeenCalledTimes(2);
    expect(client.expire).toHaveBeenCalledWith('k', 60);
  });
});

describe('FakeScoreStore (test double used by the league tests)', () => {
  it('orders like ZREVRANGE: score descending, ties by member descending', async () => {
    const store = new FakeScoreStore();
    await store.seed('k', ['a', 'b', 'c']);
    await store.incrementOnce('k', 'a', 10, { setKey: 's', id: '1' });
    expect(await store.ranked('k', 0, -1)).toEqual([
      { member: 'a', score: 10 }, { member: 'c', score: 0 }, { member: 'b', score: 0 },
    ]);
    expect(await store.ranked('k', 0, 0)).toEqual([{ member: 'a', score: 10 }]);
  });

  it('applies a dedupe id only once', async () => {
    const store = new FakeScoreStore();
    expect(await store.incrementOnce('k', 'a', 5, { setKey: 's', id: 'x' })).toBe(5);
    expect(await store.incrementOnce('k', 'a', 5, { setKey: 's', id: 'x' })).toBeNull();
    expect(store.score('k', 'a')).toBe(5);
  });
});
