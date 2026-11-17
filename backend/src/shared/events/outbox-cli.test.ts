import { describe, expect, it } from 'vitest';
import { OutboxEvent } from '../../db/models/outboxEvent.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { writeOutboxEvent } from './outbox.js';
import { listDeadEvents, republishDead } from './outbox-cli.js';

const seed = async (n: number, status: 'dead' | 'published' = 'dead') => {
  await runInTransaction(async (s) => {
    for (let i = 0; i < n; i++) {
      await writeOutboxEvent(s, {
        type: 'focus.session.completed',
        aggregateType: 'FocusSession',
        aggregateId: `a${i}`,
        userId: 'u1',
        payload: { minutes: 25 },
      });
    }
  });
  await OutboxEvent.updateMany({ status: 'pending' }, { $set: { status, attempts: 10, lastError: 'boom' } });
};

describe('outbox dead-letter cli', () => {
  it('lists only dead events, oldest first', async () => {
    await seed(2, 'published');
    await seed(3);
    const dead = await listDeadEvents();
    expect(dead).toHaveLength(3);
    expect(dead[0]).toMatchObject({ type: 'focus.session.completed', attempts: 10, lastError: 'boom' });
  });

  it('republishes one dead event and resets its retry state', async () => {
    await seed(2);
    const [first] = await listDeadEvents();
    expect(await republishDead(first.eventId)).toBe(1);
    const row = await OutboxEvent.findOne({ eventId: first.eventId }).lean();
    expect(row).toMatchObject({ status: 'pending', attempts: 0, lastError: null, leaseExpiresAt: null });
    expect(await listDeadEvents()).toHaveLength(1);
  });

  it('republishes every dead event with all', async () => {
    await seed(3);
    expect(await republishDead('all')).toBe(3);
    expect(await OutboxEvent.countDocuments({ status: 'dead' })).toBe(0);
  });

  it('leaves published events alone and ignores an unknown id', async () => {
    await seed(1, 'published');
    expect(await republishDead('all')).toBe(0);
    expect(await republishDead('no-such-id')).toBe(0);
    expect(await OutboxEvent.countDocuments({ status: 'published' })).toBe(1);
  });
});
