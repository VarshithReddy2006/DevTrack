import { describe, expect, it } from 'vitest';
import { OutboxAuditLog } from '../../db/models/outboxAuditLog.model.js';
import { OutboxEvent } from '../../db/models/outboxEvent.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { writeOutboxEvent } from './outbox.js';
import { runOutboxCli } from './outbox-cli.js';

const seed = async (n: number, status: 'dead' | 'published' = 'dead', type = 'focus.session.completed') => {
  const ids: string[] = [];
  await runInTransaction(async (s) => {
    for (let i = 0; i < n; i++) {
      const row = await writeOutboxEvent(s, {
        type,
        aggregateType: 'FocusSession',
        aggregateId: `a${i}`,
        userId: 'u1',
        payload: { minutes: 25 },
      });
      ids.push(row.eventId);
    }
  });
  await OutboxEvent.updateMany({ eventId: { $in: ids } }, { $set: { status, attempts: 10, lastError: 'boom' } });
  return ids;
};

const operator = { userId: null, username: 'ops-shell', role: null, via: 'cli' as const };

async function run(...argv: string[]) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await runOutboxCli(argv, { log: line => lines.push(line), error: line => errors.push(line) }, operator);
  return { code, lines, errors };
}

describe('outbox dead-letter cli', () => {
  it('lists only dead events, oldest first, optionally by type', async () => {
    await seed(2, 'published');
    const [first] = await seed(3);
    await seed(1, 'dead', 'jobtarget.scored');
    const all = await run('list');
    expect(all.code).toBe(0);
    expect(all.lines).toHaveLength(5);
    expect(all.lines[0]).toContain(first);
    expect(all.lines[0]).toContain('attempts=10');
    expect(all.lines.at(-1)).toBe('4 dead event(s)');
    expect((await run('list', '--type', 'jobtarget.scored')).lines.at(-1)).toBe('1 dead event(s)');
    expect((await run('list', '--limit', '2')).lines.at(-1)).toBe('4 dead event(s), showing 2');
  });

  it('retries one dead event, resets its retry state and audits it as a cli change', async () => {
    const [first] = await seed(2);
    expect(await run('retry', first)).toMatchObject({ code: 0, lines: [`retried ${first}`] });
    expect(await OutboxEvent.findOne({ eventId: first }).lean()).toMatchObject({ status: 'pending', attempts: 0, lastError: null, leaseExpiresAt: null });
    expect(await OutboxAuditLog.findOne({ eventId: first }).lean()).toMatchObject({
      action: 'retried', actor: { via: 'cli', username: 'ops-shell' }, before: { status: 'dead', attempts: 10, lastError: 'boom' },
    });

    // A second retry of the same event is refused instead of re-queueing it again.
    const again = await run('retry', first);
    expect(again.code).toBe(1);
    expect(again.errors[0]).toContain('is pending, expected dead');
    expect(await OutboxAuditLog.countDocuments({ eventId: first })).toBe(1);
  });

  it('retries every dead event of a type with retry-all', async () => {
    await seed(3);
    await seed(2, 'dead', 'jobtarget.scored');
    expect((await run('retry-all', '--type', 'focus.session.completed')).lines).toEqual(['retried 3 event(s)']);
    expect(await OutboxEvent.countDocuments({ status: 'dead' })).toBe(2);
    expect((await run('retry-all')).lines).toEqual(['retried 2 event(s)']);
    expect(await OutboxEvent.countDocuments({ status: 'dead' })).toBe(0);
    expect(await OutboxAuditLog.countDocuments({ action: 'retried' })).toBe(5);
  });

  it('keeps the old republish command working', async () => {
    const [first] = await seed(3);
    expect((await run('republish', first)).lines).toEqual(['republished 1 event(s)']);
    expect((await run('republish', '--all')).lines).toEqual(['republished 2 event(s)']);
    expect(await OutboxEvent.countDocuments({ status: 'dead' })).toBe(0);
  });

  it('archives and purges, leaving published events alone', async () => {
    await seed(1, 'published');
    const [keep, drop] = await seed(2);
    expect((await run('archive', drop)).code).toBe(0);
    // Archived today, so the default 30 day purge keeps it.
    expect((await run('purge')).lines).toEqual(['purged 0 archived event(s) older than 30 day(s)']);
    expect((await run('purge', '--older-than', '0')).lines).toEqual(['purged 1 archived event(s) older than 0 day(s)']);
    expect(await OutboxEvent.exists({ eventId: drop })).toBeNull();
    expect(await OutboxEvent.findOne({ eventId: keep }).lean()).toMatchObject({ status: 'dead' });
    expect(await OutboxEvent.countDocuments({ status: 'published' })).toBe(1);
    expect((await OutboxAuditLog.find({ eventId: drop }).sort({ createdAt: 1 }).lean()).map(row => row.action)).toEqual(['archived', 'purged']);
  });

  it('prints usage for unknown commands and bad arguments', async () => {
    expect(await run('explode')).toMatchObject({ code: 1, errors: [expect.stringContaining('usage:')] });
    expect(await run('retry')).toMatchObject({ code: 1 });
    expect(await run('purge', '--older-than', 'soon')).toMatchObject({ code: 1, errors: ['Not a valid number: soon'] });
    expect(await run('retry', 'no-such-id')).toMatchObject({ code: 1, errors: ['Outbox event no-such-id not found'] });
  });
});
