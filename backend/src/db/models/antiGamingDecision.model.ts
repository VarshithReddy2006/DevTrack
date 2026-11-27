// src/db/models/antiGamingDecision.model.ts: permanent record of maintainer anti-gaming decisions.
// ProfileAuditLog expires after 90 days, but a pardon or a confirmed-gaming penalty has to stay
// on record for as long as the account exists. Rows are written once and never changed: the
// query hooks below reject updates and deletes made through the model. Account erasure is the one
// exception, through eraseAntiGamingDecisions.
import mongoose, { Schema, type ClientSession, type Document, type Types } from 'mongoose';

export const ANTI_GAMING_ACTIONS = ['pardon', 'penalize'] as const;
export type AntiGamingAction = typeof ANTI_GAMING_ACTIONS[number];

export interface IAntiGamingDecision extends Document {
  userId: Types.ObjectId;
  action: AntiGamingAction;
  note: string;
  actor: { userId: Types.ObjectId; username: string; role: string };
  /** Profile state the maintainer looked at. */
  suspicionScore: number;
  flags: string[];
  /** Only set for a penalty. */
  xp: {
    revoked: number;
    transactions: number;
    since: Date;
    totalBefore: number;
    totalAfter: number;
    levelBefore: number;
    levelAfter: number;
  } | null;
  badgesRemoved: string[];
  auditLogId: Types.ObjectId;
  createdAt: Date;
}

const AntiGamingDecisionSchema = new Schema<IAntiGamingDecision>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ANTI_GAMING_ACTIONS, required: true },
    note: { type: String, required: true, maxlength: 1000 },
    actor: {
      userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      username: { type: String, required: true },
      role: { type: String, required: true },
    },
    suspicionScore: { type: Number, required: true },
    flags: [{ type: String }],
    xp: {
      type: new Schema({
        revoked: { type: Number, required: true, min: 0 },
        transactions: { type: Number, required: true, min: 0 },
        since: { type: Date, required: true },
        totalBefore: { type: Number, required: true, min: 0 },
        totalAfter: { type: Number, required: true, min: 0 },
        levelBefore: { type: Number, required: true, min: 1 },
        levelAfter: { type: Number, required: true, min: 1 },
      }, { _id: false }),
      default: null,
    },
    badgesRemoved: [{ type: String }],
    auditLogId: { type: Schema.Types.ObjectId, ref: 'ProfileAuditLog', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AntiGamingDecisionSchema.index({ userId: 1, createdAt: -1 });

function rejectChange(): never {
  throw new Error('AntiGamingDecision records are append-only');
}
AntiGamingDecisionSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'],
  rejectChange,
);
AntiGamingDecisionSchema.pre('save', function () {
  if (!this.isNew) rejectChange();
});

export const AntiGamingDecision = mongoose.model<IAntiGamingDecision>('AntiGamingDecision', AntiGamingDecisionSchema);

/** GDPR erasure: removes the user's own decisions. Goes to the collection, past the append-only hooks. */
export async function eraseAntiGamingDecisions(userId: Types.ObjectId, session: ClientSession | null): Promise<number> {
  const result = await AntiGamingDecision.collection.deleteMany({ userId }, session ? { session } : {});
  return result.deletedCount;
}
