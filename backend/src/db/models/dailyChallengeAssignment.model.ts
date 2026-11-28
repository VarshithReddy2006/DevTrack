// src/db/models/dailyChallengeAssignment.model.ts — The challenge tier a user got for one local day
import mongoose, { Schema, type Document, type Types } from 'mongoose';
import type { IDailyChallenge } from './dailyChallenge.model.js';

export interface IDailyChallengeAssignment extends Document {
  userId: Types.ObjectId;
  dayKey: string; // YYYY-MM-DD in the user's timezone
  difficulty: IDailyChallenge['difficulty'];
  problemId: string; // titleSlug of the assigned challenge
  assignedAt: Date;
}

const dailyChallengeAssignmentSchema = new Schema<IDailyChallengeAssignment>({
  userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  dayKey: { type: String, required: true },
  difficulty: { type: String, required: true, enum: ['easy', 'medium', 'hard'] },
  problemId: { type: String, required: true },
  assignedAt: { type: Date, required: true },
});

// One assignment per user per local day. Production gets this index from the versioned migration.
dailyChallengeAssignmentSchema.index({ userId: 1, dayKey: 1 }, { unique: true });

export const DailyChallengeAssignment = mongoose.model<IDailyChallengeAssignment>(
  'DailyChallengeAssignment',
  dailyChallengeAssignmentSchema,
);
export default DailyChallengeAssignment;
