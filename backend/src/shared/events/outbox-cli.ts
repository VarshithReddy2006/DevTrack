// src/shared/events/outbox-cli.ts: dead-letter tooling for the outbox (npm run outbox:dlq -- <command>).
//   list [--type <type>] [--archived] [--limit <n>]
//   retry <eventId>
//   retry-all [--type <type>]
//   archive <eventId>
//   purge [--older-than <days>]          deletes archived events, default: archived 30+ days ago
//   republish <eventId|--all>            older name for retry / retry-all
// The logic lives in modules/ops/outboxDlq.service.ts, shared with the /ops/outbox/dlq API, so
// every change made here is guarded and audited the same way.
import { userInfo } from 'node:os';
import type { OutboxAuditActor } from '../../db/models/outboxAuditLog.model.js';
import { OutboxEvent } from '../../db/models/outboxEvent.model.js';
import {
  archiveDeadLetter,
  DLQ_BATCH_LIMIT,
  listDeadLetters,
  OutboxDlqError,
  purgeArchived,
  retryDeadLetter,
  retryDeadLetters,
} from '../../modules/ops/outboxDlq.service.js';

const USAGE = 'usage: outbox-cli list [--type <type>] [--archived] [--limit <n>] | retry <eventId> | retry-all [--type <type>]'
  + ' | archive <eventId> | purge [--older-than <days>] | republish <eventId|--all>';

export interface CliOutput {
  log: (line: string) => void;
  error: (line: string) => void;
}

function cliActor(): OutboxAuditActor {
  let username = 'cli';
  try { username = userInfo().username || username; } catch { /* no passwd entry in some containers */ }
  return { userId: null, username, role: null, via: 'cli' };
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function nonNegative(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new OutboxDlqError(`Not a valid number: ${value}`, 'BAD_ARGUMENT', 400);
  return n;
}

/** Re-queues every dead event (of one type), one guarded batch at a time. */
async function retryAll(type: string | undefined, actor: OutboxAuditActor): Promise<number> {
  // Bounded by what was dead when we started, so events that die again meanwhile are left alone.
  const budget = await OutboxEvent.countDocuments({ status: 'dead', ...(type && { type }) });
  let total = 0;
  while (total < budget) {
    const { retried } = await retryDeadLetters({ type, limit: Math.min(DLQ_BATCH_LIMIT, budget - total) }, actor);
    if (!retried.length) break;
    total += retried.length;
  }
  return total;
}

/** Runs one command against the current mongoose connection. Returns the exit code. */
export async function runOutboxCli(argv: string[], out: CliOutput = console, actor: OutboxAuditActor = cliActor()): Promise<number> {
  const [cmd, arg, ...rest] = argv;
  const flags = [arg, ...rest].filter((value): value is string => value !== undefined);
  try {
    switch (cmd) {
      case 'list': {
        const pageSize = Math.min(Math.max(1, nonNegative(option(flags, '--limit'), 50)), 100);
        const status = flags.includes('--archived') ? 'archived' : 'dead';
        const { items, pagination } = await listDeadLetters({ status, type: option(flags, '--type') }, { page: 1, pageSize });
        for (const e of items) {
          out.log(`${e.eventId}  ${e.type}  attempts=${e.attempts}  last=${e.lastAttemptAt?.toISOString() ?? '-'}  ${e.lastError ?? ''}`);
        }
        out.log(`${pagination.totalItems} ${status} event(s)${pagination.totalItems > items.length ? `, showing ${items.length}` : ''}`);
        return 0;
      }
      case 'retry':
        if (!arg) break;
        await retryDeadLetter(arg, actor);
        out.log(`retried ${arg}`);
        return 0;
      case 'retry-all': {
        const n = await retryAll(option(flags, '--type'), actor);
        out.log(`retried ${n} event(s)`);
        return 0;
      }
      case 'republish':
        if (!arg) break;
        if (arg === '--all') {
          out.log(`republished ${await retryAll(undefined, actor)} event(s)`);
        } else {
          await retryDeadLetter(arg, actor);
          out.log('republished 1 event(s)');
        }
        return 0;
      case 'archive':
        if (!arg) break;
        await archiveDeadLetter(arg, actor);
        out.log(`archived ${arg}`);
        return 0;
      case 'purge': {
        const days = nonNegative(option(flags, '--older-than'), 30);
        out.log(`purged ${await purgeArchived(days, actor)} archived event(s) older than ${days} day(s)`);
        return 0;
      }
      default:
        break;
    }
    out.error(USAGE);
    return 1;
  } catch (error) {
    if (error instanceof OutboxDlqError) {
      out.error(error.message);
      return 1;
    }
    throw error;
  }
}

async function main(argv: string[]): Promise<number> {
  const { default: mongoose } = await import('mongoose');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    return 1;
  }
  await mongoose.connect(uri);
  try {
    return await runOutboxCli(argv);
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && /outbox-cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
