// src/db/models/userStreakLog.model.ts — Streak log for timezone-safe streak computation
// Immutable daily activity log per user, supports DSA, GitHub, and unified streaks.

import mongoose, { Schema, type Document } from 'mongoose';

export type StreakType = 'dsa' | 'github' | 'unified' | 'focus';

export interface IUserStreakLog extends Document {
  userId: Schema.Types.ObjectId;
  date: Date; // Normalized to UTC midnight of user's timezone
  dateKey?: string; // Normalized date string YYYY-MM-DD
  streakType: StreakType;
  activityCount: number;
  sources: string[]; // e.g., submissionIds, commit SHAs
  timezone: string; // User's timezone (e.g., 'Asia/Kolkata')
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const userStreakLogSchema = new Schema<IUserStreakLog>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    date: { type: Date, required: true },
    dateKey: { type: String, index: true },
    streakType: {
      type: String,
      required: true,
      enum: ['dsa', 'github', 'unified', 'focus'],
    },
    activityCount: { type: Number, required: true, min: 0, default: 1 },
    sources: { type: [String], default: [] },
    timezone: { type: String, required: true, default: 'UTC' },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Unique constraint: one log per user per date per streak type
userStreakLogSchema.index(
  { userId: 1, date: 1, streakType: 1 },
  { unique: true }
);

// Query indexes for streak computation
userStreakLogSchema.index({ userId: 1, date: -1 });
userStreakLogSchema.index({ userId: 1, streakType: 1, date: -1 });

export const UserStreakLog = mongoose.model<IUserStreakLog>('UserStreakLog', userStreakLogSchema);