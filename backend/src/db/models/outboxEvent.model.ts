// src/db/models/outboxEvent.model.ts — Transactional Outbox rows (Guardrail G4).
// Written in the same MongoDB transaction as the state change they describe;
// the relay in shared/events/outboxRelay.ts publishes them to BullMQ afterwards.
import { Schema, model, type Document } from 'mongoose';

export type OutboxStatus = 'pending' | 'processing' | 'published' | 'dead';

export interface IOutboxEvent extends Document {
  eventId: string;
  /** dot-case event type, e.g. `focus.session.completed` */
  type: string;
  schemaVersion: number;
  aggregateType: string;
  aggregateId: string;
  userId: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  /** While `processing`, the claim is valid until this time; afterwards another relay may take it. */
  leaseExpiresAt: Date | null;
  /** Earliest time a `pending` event may be claimed again (exponential backoff). */
  nextAttemptAt: Date;
  lastError: string | null;
  traceContext: Record<string, string>;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const outboxEventSchema = new Schema<IOutboxEvent>(
  {
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    schemaVersion: { type: Number, required: true, default: 1 },
    aggregateType: { type: String, required: true },
    aggregateId: { type: String, required: true },
    userId: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true, default: {} },
    status: { type: String, enum: ['pending', 'processing', 'published', 'dead'], default: 'pending', required: true },
    attempts: { type: Number, default: 0 },
    leaseExpiresAt: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastError: { type: String, default: null },
    traceContext: { type: Schema.Types.Mixed, default: {} },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

outboxEventSchema.index({ eventId: 1 }, { unique: true });
outboxEventSchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });
outboxEventSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export const OutboxEvent = model<IOutboxEvent>('OutboxEvent', outboxEventSchema);
