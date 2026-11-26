import mongoose, { Schema, type Types } from 'mongoose';
import type { IQuest } from './quest.model.js';

export type QuestProgressStatus = 'in_progress' | 'completed' | 'expired' | 'archived';

export interface IUserQuestProgress extends Omit<IQuest, 'key'> {
  userId: Types.ObjectId;
  questId: Types.ObjectId;
  periodKey: string;
  startsAt: Date;
  expiresAt: Date;
  currentCount: number;
  status: QuestProgressStatus;
  completed: boolean;
  completedAt: Date | null;
  expiredAt: Date | null;
  finalProgressPct: number | null;
  archivedAt: Date | null;
  claimed: boolean;
  claimedAt: Date | null;
}
const schema = new Schema<IUserQuestProgress>({
  userId: { type: Schema.Types.ObjectId, required: true },
  questId: { type: Schema.Types.ObjectId, ref: 'Quest', required: true },
  periodKey: { type: String, required: true },
  slot: { type: String, required: true },
  cadence: { type: String, enum: ['daily', 'weekly'], required: true },
  division: { type: String, required: true },
  kind: { type: String, enum: ['dsa_solve', 'focus_minutes', 'revision_review'], required: true },
  title: { type: String, required: true },
  targetCount: { type: Number, required: true, min: 1 },
  xpReward: { type: Number, required: true, min: 1 },
  trophyReward: { type: Number, required: true, min: 1 },
  startsAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  currentCount: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['in_progress', 'completed', 'expired', 'archived'], default: 'in_progress' },
  completed: { type: Boolean, default: false },
  completedAt: { type: Date, default: null },
  expiredAt: { type: Date, default: null },
  finalProgressPct: { type: Number, default: null, min: 0, max: 100 },
  archivedAt: { type: Date, default: null },
  claimed: { type: Boolean, default: false },
  claimedAt: { type: Date, default: null },
}, { timestamps: true });
schema.index({ userId: 1, questId: 1, periodKey: 1 }, { unique: true });
// Tier changes cannot create additional rewarded slots during the same period.
schema.index({ userId: 1, periodKey: 1, slot: 1 }, { unique: true });
schema.index({ userId: 1, expiresAt: 1, kind: 1 });
schema.index({ status: 1, expiresAt: 1 });
export const UserQuestProgress = mongoose.model<IUserQuestProgress>('UserQuestProgress', schema);
