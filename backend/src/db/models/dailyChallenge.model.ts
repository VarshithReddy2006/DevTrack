// src/db/models/dailyChallenge.model.ts — Daily challenge tracking model
import mongoose, { Schema, type Document } from 'mongoose';

export interface IDailyChallenge extends Document {
  date: string; // YYYY-MM-DD format
  title: string;
  titleSlug: string; // Unique slug on the platform (e.g. two-sum)
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  platform: 'leetcode' | 'codeforces' | 'codechef';
  problemUrl: string;
  xpReward: number;
  completionCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const dailyChallengeSchema = new Schema<IDailyChallenge>(
  {
    date: { type: String, required: true },
    title: { type: String, required: true },
    titleSlug: { type: String, required: true },
    description: { type: String, required: true },
    difficulty: { type: String, required: true, enum: ['easy', 'medium', 'hard'] },
    platform: { type: String, required: true, enum: ['leetcode', 'codeforces', 'codechef'] },
    problemUrl: { type: String, required: true },
    xpReward: { type: Number, required: true, default: 35 },
    completionCount: { type: Number, required: true, default: 180 },
  },
  { timestamps: true }
);

// Run migrate:daily-challenge-tiers before deploying against an existing database.
dailyChallengeSchema.index({ date: 1, difficulty: 1 }, { unique: true });

export const DailyChallenge = mongoose.model<IDailyChallenge>('DailyChallenge', dailyChallengeSchema);
export default DailyChallenge;
