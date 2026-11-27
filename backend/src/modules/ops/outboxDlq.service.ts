// src/modules/ops/outboxDlq.service.ts: recovery tooling for dead-lettered outbox events.
//
// OutboxRelay marks an event `dead` after OUTBOX_MAX_ATTEMPTS failed publishes. From here a
// maintainer can list them, fix a bad payload, put them back in the queue, or archive and later
// purge the ones that cannot be saved. Every change is guarded on the event still being in the
// expected state and writes an OutboxAuditLog row in the same transaction, so two people (or an
// API call and the CLI) working on the same event cannot both apply a change.
import type { ClientSession } from 'mongoose';
import type { ZodTypeAny } from 'zod';
import { OutboxAuditLog, type OutboxAuditAction, type OutboxAuditActor } from '../../db/models/outboxAuditLog.model.js';
import { OutboxEvent, type IOutboxEvent } from '../../db/models/outboxEvent.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { focusSessionCompletedV1Schema, interviewTurnAnsweredV1Schema, jobTargetScoredV1Schema } from '../../shared/events/eventContract.js';
import { createPagination, getSkipCount, type PaginationParams } from '../../shared/pagination.js';

const DAY_MS = 86_400_000;
const SNIPPET_LENGTH = 200;
/** Upper bound for one batch retry or purge pass. */
export const DLQ_BATCH_LIMIT = 500;

export const DLQ_STATUSES = ['dead', 'archived'] as const;
export type DlqStatus = typeof DLQ_STATUSES[number];

/** Payload schemas the consumers already enforce, keyed by type and schema version. */
const PAYLOAD_SCHEMAS: Record<string, ZodTypeAny> = {
  'focus.session.completed@1': focusSessionCompletedV1Schema,
  'jobtarget.scored@1': jobTargetScoredV1Schema,
  'interview.turn.answered@1': interviewTurnAnsweredV1Schema,
};

export class OutboxDlqError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode: number, readonly details?: Record<string, string[]>) {
    super(message);
    this.name = 'OutboxDlqError';
  }
}

type EventRow = Pick<IOutboxEvent, 'eventId' | 'type' | 'schemaVersion' | 'aggregateType' | 'aggregateId' | 'userId' | 'payload'
  | 'status' | 'attempts' | 'lastError' | 'lastAttemptAt' | 'archivedAt' | 'createdAt' | 'updatedAt'> & { _id: unknown };

function snippet(payload: unknown): string {
  const text = JSON.stringify(payload ?? {});
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH)}...` : text;
}

function summary(row: EventRow) {
  return {
    eventId: row.eventId,
    type: row.type,
    schemaVersion: row.schemaVersion,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    userId: row.userId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    // Events that died before lastAttemptAt existed: their last update was the final attempt.
    lastAttemptAt: row.lastAttemptAt ?? row.updatedAt,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt ?? null,
    payloadSnippet: snippet(row.payload),
  };
}

const stateOf = (row: EventRow) => ({ status: row.status, attempts: row.attempts, lastError: row.lastError });

function auditRow(row: EventRow, action: OutboxAuditAction, actor: OutboxAuditActor, note: string | undefined,
  before: Record<string, unknown>, after: Record<string, unknown> | null) {
  return { eventId: row.eventId, eventType: row.type, action, actor, note: note ?? null, before, after };
}

const notFound = (eventId: string) => new OutboxDlqError(`Outbox event ${eventId} not found`, 'NOT_FOUND', 404);
const wrongState = (row: EventRow, expected: string) =>
  new OutboxDlqError(`Outbox event ${row.eventId} is ${row.status}, expected ${expected}`, 'INVALID_STATE', 409);

export async function listDeadLetters(filter: { status?: DlqStatus; type?: string }, params: PaginationParams) {
  const query = { status: filter.status ?? 'dead', ...(filter.type && { type: filter.type }) };
  const [rows, total] = await Promise.all([
    OutboxEvent.find(query).sort({ createdAt: 1, _id: 1 }).skip(getSkipCount(params)).limit(params.pageSize).lean<EventRow[]>(),
    OutboxEvent.countDocuments(query),
  ]);
  return { items: rows.map(summary), pagination: createPagination(total, params) };
}

/** One event with its full payload and every maintainer change made to it. */
export async function getDeadLetter(eventId: string) {
  const row = await OutboxEvent.findOne({ eventId }).lean<EventRow>();
  if (!row) throw notFound(eventId);
  const history = await OutboxAuditLog.find({ eventId }).sort({ createdAt: -1 }).select('-_id -__v').lean();
  return { ...summary(row), payload: row.payload, history };
}

async function loadInState(eventId: string, status: DlqStatus, session: ClientSession): Promise<EventRow> {
  const row = await OutboxEvent.findOne({ eventId }).session(session).lean<EventRow>();
  if (!row) throw notFound(eventId);
  if (row.status !== status) throw wrongState(row, status);
  return row;
}

const retryReset = (now: Date) => ({ status: 'pending', attempts: 0, nextAttemptAt: now, leaseExpiresAt: null, lastError: null });

/** Puts one dead event back in the queue. The relay picks it up on its next poll. */
export async function retryDeadLetter(eventId: string, actor: OutboxAuditActor, note?: string) {
  return runInTransaction(async session => {
    const row = await loadInState(eventId, 'dead', session);
    const now = new Date();
    const updated = await OutboxEvent.updateOne({ _id: row._id, status: 'dead' }, { $set: retryReset(now) }, { session });
    if (!updated.modifiedCount) throw wrongState(row, 'dead');
    await OutboxAuditLog.create([auditRow(row, 'retried', actor, note, stateOf(row), { status: 'pending', attempts: 0 })], { session });
    return { eventId, status: 'pending' as const, nextAttemptAt: now };
  });
}

export interface RetrySelection {
  eventIds?: string[];
  type?: string;
  limit?: number;
}

/**
 * Retries up to `limit` dead events matching the selection, oldest first. All of them move in
 * one transaction; a concurrent change to any of them makes the transaction retry, so an event is
 * never re-queued (or audited) twice. Requested ids that are not dead come back in `skipped`.
 */
export async function retryDeadLetters(selection: RetrySelection, actor: OutboxAuditActor, note?: string) {
  const limit = Math.min(selection.limit ?? DLQ_BATCH_LIMIT, DLQ_BATCH_LIMIT);
  const retried = await runInTransaction(async session => {
    const rows = await OutboxEvent.find({
      status: 'dead',
      ...(selection.eventIds && { eventId: { $in: selection.eventIds } }),
      ...(selection.type && { type: selection.type }),
    }).sort({ createdAt: 1, _id: 1 }).limit(limit).session(session).lean<EventRow[]>();
    if (!rows.length) return [];

    const updated = await OutboxEvent.updateMany(
      { _id: { $in: rows.map(row => row._id) }, status: 'dead' },
      { $set: retryReset(new Date()) },
      { session },
    );
    if (updated.modifiedCount !== rows.length) {
      throw new OutboxDlqError('Some events changed during the retry, run it again', 'CONCURRENT_CHANGE', 409);
    }
    await OutboxAuditLog.insertMany(
      rows.map(row => auditRow(row, 'retried', actor, note, stateOf(row), { status: 'pending', attempts: 0 })),
      { session },
    );
    return rows.map(row => row.eventId);
  });
  const done = new Set(retried);
  return { retried, skipped: (selection.eventIds ?? []).filter(id => !done.has(id)) };
}

/**
 * Replaces the payload of a dead event, e.g. to fix a malformed id before retrying it. Types with
 * a known schema are validated against it so a fix cannot introduce a different poison pill.
 */
export async function editDeadLetterPayload(eventId: string, payload: Record<string, unknown>, actor: OutboxAuditActor, note?: string) {
  return runInTransaction(async session => {
    const row = await loadInState(eventId, 'dead', session);
    const schema = PAYLOAD_SCHEMAS[`${row.type}@${row.schemaVersion}`];
    if (schema) {
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        const details: Record<string, string[]> = {};
        for (const issue of parsed.error.issues) (details[['payload', ...issue.path].join('.')] ??= []).push(issue.message);
        throw new OutboxDlqError(`Payload does not match ${row.type} v${row.schemaVersion}`, 'INVALID_PAYLOAD', 400, details);
      }
    }
    const updated = await OutboxEvent.updateOne({ _id: row._id, status: 'dead' }, { $set: { payload } }, { session });
    if (!updated.matchedCount) throw wrongState(row, 'dead');
    await OutboxAuditLog.create([auditRow(row, 'edited', actor, note, { payload: row.payload }, { payload })], { session });
    return { eventId, status: row.status, payload };
  });
}

/** Sets an unrecoverable event aside. It stays readable until it is purged. */
export async function archiveDeadLetter(eventId: string, actor: OutboxAuditActor, note?: string) {
  return runInTransaction(async session => {
    const row = await loadInState(eventId, 'dead', session);
    const archivedAt = new Date();
    const updated = await OutboxEvent.updateOne({ _id: row._id, status: 'dead' }, { $set: { status: 'archived', archivedAt } }, { session });
    if (!updated.modifiedCount) throw wrongState(row, 'dead');
    await OutboxAuditLog.create([auditRow(row, 'archived', actor, note, stateOf(row), { status: 'archived', archivedAt })], { session });
    return { eventId, status: 'archived' as const, archivedAt };
  });
}

/**
 * Deletes archived events archived at least `olderThanDays` ago. The audit row keeps a full copy
 * of each deleted event.
 */
export async function purgeArchived(olderThanDays: number, actor: OutboxAuditActor, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS);
  let purged = 0;
  for (;;) {
    const deleted = await runInTransaction(async session => {
      const rows = await OutboxEvent.find({ status: 'archived', archivedAt: { $lte: cutoff } })
        .sort({ archivedAt: 1, _id: 1 }).limit(DLQ_BATCH_LIMIT).session(session).lean<EventRow[]>();
      if (!rows.length) return 0;
      const result = await OutboxEvent.deleteMany({ _id: { $in: rows.map(row => row._id) }, status: 'archived' }, { session });
      if (result.deletedCount !== rows.length) {
        throw new OutboxDlqError('Some events changed during the purge, run it again', 'CONCURRENT_CHANGE', 409);
      }
      await OutboxAuditLog.insertMany(rows.map(({ _id, ...event }) => auditRow(event as EventRow, 'purged', actor, undefined, event, null)), { session });
      return rows.length;
    });
    purged += deleted;
    if (deleted < DLQ_BATCH_LIMIT) return purged;
  }
}
