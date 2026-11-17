// src/shared/events/outbox-cli.ts — dead-letter tooling for the outbox.
//   tsx src/shared/events/outbox-cli.ts list
//   tsx src/shared/events/outbox-cli.ts republish <eventId|--all>
import { OutboxEvent } from '../../db/models/outboxEvent.model.js';

export interface DeadEventSummary {
  eventId: string;
  type: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

export async function listDeadEvents(limit = 50): Promise<DeadEventSummary[]> {
  const rows = await OutboxEvent.find({ status: 'dead' }).sort({ createdAt: 1 }).limit(limit).lean();
  return rows.map((r) => ({ eventId: r.eventId, type: r.type, attempts: r.attempts, lastError: r.lastError, createdAt: r.createdAt }));
}

/** Puts dead events back in the queue for the relay. Returns how many moved. */
export async function republishDead(target: string | 'all'): Promise<number> {
  const filter = target === 'all' ? { status: 'dead' } : { status: 'dead', eventId: target };
  const res = await OutboxEvent.updateMany(filter, {
    $set: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), leaseExpiresAt: null, lastError: null },
  });
  return res.modifiedCount;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  const { default: mongoose } = await import('mongoose');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    return 1;
  }
  await mongoose.connect(uri);
  try {
    if (cmd === 'list') {
      const dead = await listDeadEvents();
      for (const d of dead) console.log(`${d.eventId}  ${d.type}  attempts=${d.attempts}  ${d.lastError ?? ''}`);
      console.log(`${dead.length} dead event(s)`);
      return 0;
    }
    if (cmd === 'republish' && arg) {
      const n = await republishDead(arg === '--all' ? 'all' : arg);
      console.log(`republished ${n} event(s)`);
      return 0;
    }
    console.error('usage: outbox-cli list | republish <eventId|--all>');
    return 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && /outbox-cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
