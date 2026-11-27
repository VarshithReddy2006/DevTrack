// src/db/models/outboxAuditLog.model.ts: one row per maintainer change to a dead-lettered outbox event.
// Written in the same transaction as the change. `before` keeps what the event looked like, so a
// purged event can still be read back from here.
import mongoose, { Schema, type Document } from 'mongoose';

export const OUTBOX_AUDIT_ACTIONS = ['retried', 'edited', 'archived', 'purged'] as const;
export type OutboxAuditAction = typeof OUTBOX_AUDIT_ACTIONS[number];

export interface OutboxAuditActor {
  /** Mongo user id for API calls, null for the CLI. */
  userId: string | null;
  username: string;
  role: string | null;
  via: 'api' | 'cli';
}

export interface IOutboxAuditLog extends Document {
  eventId: string;
  eventType: string;
  action: OutboxAuditAction;
  actor: OutboxAuditActor;
  note: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown> | null;
  createdAt: Date;
}

const OutboxAuditLogSchema = new Schema<IOutboxAuditLog>(
  {
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    action: { type: String, enum: OUTBOX_AUDIT_ACTIONS, required: true },
    actor: {
      userId: { type: String, default: null },
      username: { type: String, required: true },
      role: { type: String, default: null },
      via: { type: String, enum: ['api', 'cli'], required: true },
    },
    note: { type: String, default: null, maxlength: 500 },
    before: { type: Schema.Types.Mixed, required: true },
    after: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false }
);

OutboxAuditLogSchema.index({ eventId: 1, createdAt: -1 });
OutboxAuditLogSchema.index({ createdAt: -1 });

OutboxAuditLogSchema.pre('save', function () {
  if (!this.isNew) throw new Error('OutboxAuditLog rows are append-only');
});
OutboxAuditLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function () {
    throw new Error('OutboxAuditLog rows are append-only');
  },
);

export const OutboxAuditLog = mongoose.model<IOutboxAuditLog>('OutboxAuditLog', OutboxAuditLogSchema);
