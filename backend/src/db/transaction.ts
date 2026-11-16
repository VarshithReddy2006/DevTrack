// src/db/transaction.ts — run a unit of work in one MongoDB transaction.
import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` inside a transaction with snapshot reads and majority writes.
 * `withTransaction` retries transient errors, so `fn` must be safe to run more
 * than once: do all writes through the session and keep other side effects
 * (queues, HTTP calls) out of it, which is what the outbox is for.
 * A thrown error aborts the transaction and is rethrown.
 */
export async function runInTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
}
