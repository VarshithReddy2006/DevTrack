// src/db/models/auditCheckpoint.model.ts: signed daily roots of the ProfileAuditLog hash chain.
// ProfileAuditLog rows expire after 90 days, which deletes the start of the chain. Each checkpoint
// seals one UTC day's range of sequence numbers, so verification can start from a checkpoint
// instead of the (long gone) first record. Checkpoints never expire and form their own chain
// through previousCheckpointHash.
import mongoose, { Schema, type Document } from 'mongoose';

const HASH = /^[0-9a-f]{64}$/;

export interface IAuditCheckpoint extends Document {
  /** UTC day sealed by this checkpoint, YYYY-MM-DD. */
  day: string;
  /** First sequence number in the range. For a day without records this is toSequence + 1. */
  fromSequence: number;
  toSequence: number;
  recordCount: number;
  /** recordHash of the record just before fromSequence: the anchor a verification starts from. */
  anchorHash: string;
  /** recordHash of the record at toSequence, or anchorHash for an empty day. */
  lastRecordHash: string;
  /** Merkle root over the range's record hashes (GENESIS_HASH for an empty day). */
  merkleRoot: string;
  previousCheckpointHash: string;
  /** sha256 over the fields above. */
  checkpointHash: string;
  /** HMAC-SHA256 of checkpointHash with AUDIT_CHECKPOINT_SECRET. */
  signature: string;
  createdAt: Date;
}

const AuditCheckpointSchema = new Schema<IAuditCheckpoint>(
  {
    day: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    fromSequence: { type: Number, required: true, min: 1 },
    toSequence: { type: Number, required: true, min: 0 },
    recordCount: { type: Number, required: true, min: 0 },
    anchorHash: { type: String, required: true, match: HASH },
    lastRecordHash: { type: String, required: true, match: HASH },
    merkleRoot: { type: String, required: true, match: HASH },
    previousCheckpointHash: { type: String, required: true, match: HASH },
    checkpointHash: { type: String, required: true, match: HASH },
    signature: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditCheckpointSchema.index({ day: 1 }, { unique: true });
AuditCheckpointSchema.index({ toSequence: 1 });

AuditCheckpointSchema.pre('save', function () {
  if (!this.isNew) throw new Error('AuditCheckpoint records are append-only');
});
AuditCheckpointSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  function () {
    throw new Error('AuditCheckpoint records are append-only');
  },
);

export const AuditCheckpoint = mongoose.model<IAuditCheckpoint>('AuditCheckpoint', AuditCheckpointSchema);
