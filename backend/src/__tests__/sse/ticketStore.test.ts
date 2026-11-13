import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fake Redis that mimics the race: get/del each yield to the event loop, so a
// get-then-del consume lets two callers read the same value. getdel/eval run
// to completion synchronously, like a real single-threaded Redis command.
const store = new Map<string, string>();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const redis = {
  status: 'ready' as string,
  setex: vi.fn(async (key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => {
    await tick();
    return store.get(key) ?? null;
  }),
  del: vi.fn(async (key: string) => {
    await tick();
    return store.delete(key) ? 1 : 0;
  }),
  getdel: vi.fn(async (key: string): Promise<string | null> => {
    await tick();
    const v = store.get(key) ?? null;
    store.delete(key);
    return v;
  }),
  eval: vi.fn(async (_script: string, _numKeys: number, key: string): Promise<string | null> => {
    await tick();
    const v = store.get(key) ?? null;
    store.delete(key);
    return v;
  }),
};

vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => redis,
  getRedisHealth: () => ({ status: 'connected' }),
  isRedisConfigured: () => false,
  createRedisConnection: vi.fn(),
}));

vi.mock('../../services/auth/ClerkUserSyncService.js', () => ({
  syncClerkUser: vi.fn(),
}));

import { createHandshakeTicket, consumeHandshakeTicket } from '../../shared/sse/ticketStore.js';
import { logger } from '../../shared/logger.js';
import { sseHandshake } from '../../modules/auth/auth.controller.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type { Response } from 'express';

function spyOnLogger() {
  return [
    vi.spyOn(logger, 'info'),
    vi.spyOn(logger, 'warn'),
    vi.spyOn(logger, 'error'),
    vi.spyOn(logger, 'debug'),
  ];
}

function loggedText(spies: ReturnType<typeof spyOnLogger>): string {
  return JSON.stringify(spies.flatMap((s) => s.mock.calls));
}

describe('handshake ticket store, Redis path', () => {
  beforeEach(() => {
    store.clear();
    redis.status = 'ready';
    redis.getdel.mockClear();
    redis.eval.mockClear();
    redis.get.mockClear();
    redis.del.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns the userId for a valid ticket and then null', async () => {
    const ticket = await createHandshakeTicket('user-1');
    expect(await consumeHandshakeTicket(ticket)).toBe('user-1');
    expect(await consumeHandshakeTicket(ticket)).toBe(null);
  });

  it('consumes with a single atomic command, not GET then DEL', async () => {
    const ticket = await createHandshakeTicket('user-1');
    await consumeHandshakeTicket(ticket);
    expect(redis.getdel).toHaveBeenCalledTimes(1);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('lets exactly one of many concurrent redeems win', async () => {
    const ticket = await createHandshakeTicket('user-1');
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeHandshakeTicket(ticket)));
    expect(results.filter((r) => r === 'user-1')).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(19);
  });

  it('would double-redeem with the old GET then DEL pattern (race sanity check)', async () => {
    const ticket = await createHandshakeTicket('user-1');
    const naive = async () => {
      const v = await redis.get(`sse:ticket:${ticket}`);
      if (v) await redis.del(`sse:ticket:${ticket}`);
      return v;
    };
    const results = await Promise.all([naive(), naive()]);
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it('falls back to an atomic Lua script when GETDEL is unknown', async () => {
    const unknown = new Error("ERR unknown command 'getdel'");
    redis.getdel.mockRejectedValueOnce(unknown).mockRejectedValueOnce(unknown);
    const ticket = await createHandshakeTicket('user-2');
    const results = await Promise.all([consumeHandshakeTicket(ticket), consumeHandshakeTicket(ticket)]);
    expect(results.filter((r) => r === 'user-2')).toHaveLength(1);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('GET'");
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('DEL'");
  });

  it('returns null for an unknown ticket', async () => {
    expect(await consumeHandshakeTicket('does-not-exist')).toBe(null);
  });
});

describe('handshake ticket store, memory fallback', () => {
  beforeEach(() => {
    store.clear();
    redis.status = 'end';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is single-use, including under concurrent redeems', async () => {
    const ticket = await createHandshakeTicket('user-3');
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeHandshakeTicket(ticket)));
    expect(results.filter((r) => r === 'user-3')).toHaveLength(1);
    expect(await consumeHandshakeTicket(ticket)).toBe(null);
  });

  it('rejects an expired ticket without logging it', async () => {
    vi.useFakeTimers();
    const spies = spyOnLogger();
    const ticket = await createHandshakeTicket('user-4');
    vi.advanceTimersByTime(11_000);
    expect(await consumeHandshakeTicket(ticket)).toBe(null);
    expect(spies[1]).toHaveBeenCalled();
    expect(loggedText(spies)).not.toContain(ticket);
  });
});

describe('ticket log redaction', () => {
  beforeEach(() => {
    store.clear();
    redis.status = 'ready';
  });
  afterEach(() => vi.restoreAllMocks());

  it('sseHandshake does not log the ticket it returns', async () => {
    const spies = spyOnLogger();
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) } as unknown as Response;
    await sseHandshake({ user: { id: 'user-5' } } as unknown as AuthenticatedRequest, res);

    const body = json.mock.calls[0][0] as { data: { ticket: string } };
    const ticket = body.data.ticket;
    expect(ticket).toBeTruthy();
    expect(loggedText(spies)).not.toContain(ticket);
    expect(spies[0]).toHaveBeenCalledWith(expect.any(String), { userId: 'user-5' });
  });

  it('a Redis read failure is logged without the ticket', async () => {
    const spies = spyOnLogger();
    redis.getdel.mockRejectedValueOnce(new Error('connection reset'));
    const ticket = await createHandshakeTicket('user-6');
    await consumeHandshakeTicket(ticket);
    expect(spies[1]).toHaveBeenCalled();
    expect(loggedText(spies)).not.toContain(ticket);
  });
});
