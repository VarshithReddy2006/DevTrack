// Outbox: transaction atomicity, lease claims, retry and dead-letter.
// Runs on the replica-set Mongo that vitest.setup.ts provides, since
// transactions need one.
import { describe, expect, it, vi } from 'vitest';
import { OutboxEvent } from '../../db/models/outboxEvent.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { writeOutboxEvent } from './outbox.js';
import { backoffMs, OutboxRelay } from './outboxRelay.js';

const input = (over: Record<string, unknown> = {}) => ({
  type: 'focus.session.completed',
  aggregateType: 'FocusSession',
  aggregateId: 'fs-1',
  userId: 'u1',
  payload: { minutes: 25 },
  ...over,
});

describe('writeOutboxEvent', () => {
  it('commits with the surrounding transaction', async () => {
    const doc = await runInTransaction((s) => writeOutboxEvent(s, input()));
    const row = await OutboxEvent.findOne({ eventId: doc.eventId }).lean();
    expect(row?.status).toBe('pending');
    expect(row?.schemaVersion).toBe(1);
    expect(row?.attempts).toBe(0);
  });

  it('discards the event when the transaction rolls back', async () => {
    await expect(
      runInTransaction(async (s) => {
        await writeOutboxEvent(s, input());
        throw new Error('write conflict');
      }),
    ).rejects.toThrow('write conflict');
    expect(await OutboxEvent.countDocuments()).toBe(0);
  });

  it('rejects a bad type or payload before writing', async () => {
    await expect(runInTransaction((s) => writeOutboxEvent(s, input({ type: 'NotDotCase' })))).rejects.toThrow();
    await expect(runInTransaction((s) => writeOutboxEvent(s, input({ payload: 'nope' })))).rejects.toThrow();
    expect(await OutboxEvent.countDocuments()).toBe(0);
  });

  it('refuses to run outside a transaction', async () => {
    const mongoose = (await import('mongoose')).default;
    const session = await mongoose.startSession();
    await expect(writeOutboxEvent(session, input())).rejects.toThrow(/active transaction/);
    await session.endSession();
  });
});

describe('OutboxRelay', () => {
  const seed = (n: number) => runInTransaction(async (s) => {
    for (let i = 0; i < n; i++) await writeOutboxEvent(s, input({ aggregateId: `a${i}` }));
  });

  it('publishes one job per subscribed queue with jobId = eventId', async () => {
    await seed(1);
    const enqueue = vi.fn(async () => {});
    const relay = new OutboxRelay({ resolveQueues: () => ['xp-processing', 'notifications'], enqueue });
    expect(await relay.tick()).toBe(1);
    const row = await OutboxEvent.findOne().lean();
    expect(row?.status).toBe('published');
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith('xp-processing', row!.eventId, expect.objectContaining({ id: row!.eventId, type: 'focus.session.completed' }));
  });

  it('two relays never claim the same event', async () => {
    await seed(12);
    const seen: string[] = [];
    const enqueue = async (_q: string, jobId: string) => { seen.push(jobId); };
    const a = new OutboxRelay({ resolveQueues: () => ['q'], enqueue, batchSize: 12 });
    const b = new OutboxRelay({ resolveQueues: () => ['q'], enqueue, batchSize: 12 });
    await Promise.all([a.tick(), b.tick()]);
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('reclaims an event whose lease expired after a crash', async () => {
    await seed(1);
    const crashed = new OutboxRelay({ resolveQueues: () => ['q'], enqueue: async () => {}, leaseMs: 1_000 });
    const [claimed] = await crashed.claimBatch(); // claimed, never published
    expect(claimed.status).toBe('processing');

    const fresh = new OutboxRelay({ resolveQueues: () => ['q'], enqueue: async () => {} });
    expect(await fresh.claimBatch()).toHaveLength(0); // lease still valid

    const later = new Date(Date.now() + 5_000);
    const rescuer = new OutboxRelay({ resolveQueues: () => ['q'], enqueue: async () => {}, now: () => later });
    expect(await rescuer.tick()).toBe(1);
    expect((await OutboxEvent.findOne().lean())?.status).toBe('published');
  });

  it('backs off after a failed publish and succeeds on a later try', async () => {
    await seed(1);
    let fail = true;
    const enqueue = async () => { if (fail) throw new Error('redis down'); };
    const relay = new OutboxRelay({ resolveQueues: () => ['q'], enqueue });
    await relay.tick();
    const row = await OutboxEvent.findOne().lean();
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe('redis down');
    expect(await relay.claimBatch()).toHaveLength(0); // not due yet

    fail = false;
    const later = new OutboxRelay({ resolveQueues: () => ['q'], enqueue, now: () => new Date(Date.now() + 10_000) });
    expect(await later.tick()).toBe(1);
    expect((await OutboxEvent.findOne().lean())?.status).toBe('published');
  });

  it('goes dead after the maximum attempts', async () => {
    await seed(1);
    let clock = Date.now();
    const relay = new OutboxRelay({
      resolveQueues: () => ['q'],
      enqueue: async () => { throw new Error('boom'); },
      maxAttempts: 3,
      now: () => new Date(clock),
    });
    for (let i = 0; i < 3; i++) {
      await relay.tick();
      clock += 10 * 60_000;
    }
    const row = await OutboxEvent.findOne().lean();
    expect(row?.status).toBe('dead');
    expect(row?.attempts).toBe(3);
  });
});

describe('backoffMs', () => {
  it('doubles and caps', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(4)).toBe(8_000);
    expect(backoffMs(30)).toBe(300_000);
  });
});
