// src/shared/events/outbox.ts — write side of the Transactional Outbox.
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { z } from 'zod';
import { OutboxEvent, type IOutboxEvent } from '../../db/models/outboxEvent.model.js';

const DOT_CASE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

export const outboxEventInputSchema = z.object({
  type: z.string().regex(DOT_CASE, 'type must be dot-case, e.g. focus.session.completed'),
  schemaVersion: z.number().int().min(1).default(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  userId: z.string().min(1),
  payload: z.record(z.unknown()),
  traceContext: z.record(z.string()).default({}),
});

export type OutboxEventInput = z.input<typeof outboxEventInputSchema>;

/**
 * Inserts an outbox row inside the caller's transaction. If the transaction
 * rolls back, the row goes with it, so a consumer can never see an event for
 * state that was never committed. A transaction session is required on
 * purpose: without one the dual-write problem is back.
 */
export async function writeOutboxEvent(session: ClientSession, input: OutboxEventInput): Promise<IOutboxEvent> {
  if (!session || !session.inTransaction()) {
    throw new Error('writeOutboxEvent must be called inside an active transaction session');
  }
  const data = outboxEventInputSchema.parse(input);
  const [doc] = await OutboxEvent.create([{ ...data, eventId: randomUUID(), status: 'pending' }], { session });
  return doc;
}
