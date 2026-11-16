// src/db/models/xpTransaction.model.ts — Immutable XP transaction log
// Every XP award creates one transaction record.
// Idempotent via (userId + sourceType + sourceId) uniqueness.

import mongoose, { Schema, type Document } from 'mongoose';

export type XpSourceType =
  | 'dsa_accepted'
  | 'dsa_contest'
  | 'daily_streak'
  | 'sync_completed'
  | 'challenge_completed'
  | 'focus_session'
  | 'milestone'
  | 'manual'
  | 'revision_review';

export interface IXpTransaction extends Document {
  userId: Schema.Types.ObjectId;
  sourceType: XpSourceType;
  sourceId: string; // unique per sourceType per user (e.g., submissionId, contestId)
  xpAwarded: number;
  previousTotalXp: number;
  newTotalXp: number;
  levelBefore: number;
  levelAfter: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const xpTransactionSchema = new Schema<IXpTransaction>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    sourceType: {
      type: String,
      required: true,
      enum: [
        'dsa_accepted',
        'dsa_contest',
        'daily_streak',
        'sync_completed',
        'challenge_completed',
        'focus_session',
        'milestone',
        'manual',
        'revision_review',
      ],
    },
    sourceId: { type: String, required: true },
    xpAwarded: { type: Number, required: true, min: 0 },
    previousTotalXp: { type: Number, required: true, min: 0 },
    newTotalXp: { type: Number, required: true, min: 0 },
    levelBefore: { type: Number, required: true, min: 1 },
    levelAfter: { type: Number, required: true, min: 1 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } // immutable
  }
);

// Core idempotency constraint — prevents duplicate XP awards
xpTransactionSchema.index(
  { userId: 1, sourceType: 1, sourceId: 1 },
  { unique: true }
);

// Query indexes
xpTransactionSchema.index({ userId: 1, createdAt: -1 });
xpTransactionSchema.index({ userId: 1, sourceType: 1 });
xpTransactionSchema.index({ createdAt: -1 });

export const XpTransaction = mongoose.model<IXpTransaction>('XpTransaction', xpTransactionSchema);