// src/db/models/userAnalytics.model.ts — Precomputed user analytics for fast dashboard reads
// All dashboard-critical reads come from this document via cache-first pattern.
// Workers update analytics asynchronously - no aggregation at request time.

import mongoose, { Schema, type Document } from 'mongoose';

export interface IUserAnalytics extends Document {
  userId: Schema.Types.ObjectId;

  // Streak fields
  currentStreak: number;
  bestStreak: number;
  currentStreakType: 'dsa' | 'github' | 'unified' | 'focus' | null;
  lastActiveDate: Date | null;
  streakFreezeUntil: Date | null;

  // XP fields
  totalXp: number;
  currentLevel: number;

  // Activity fields
  dsaSolveCount: number;
  weeklyConsistencyScore: number; // 0-100

  // Weekly XP history (last 12 weeks)
  weeklyXPHistory: Array<{ weekStart: Date; xp: number }>;

  // Readiness scores
  placementReadinessScore: number; // placeholder - 0-100

  // Metadata
  updatedAt: Date;
  computedAt: Date;
}

const userAnalyticsSchema = new Schema<IUserAnalytics>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },

    // Streak
    currentStreak: { type: Number, default: 0, min: 0 },
    bestStreak: { type: Number, default: 0, min: 0 },
    currentStreakType: { type: String, enum: ['dsa', 'github', 'unified', 'focus', null], default: null },
    lastActiveDate: { type: Date, default: null },
    streakFreezeUntil: { type: Date, default: null },

    // XP
    totalXp: { type: Number, default: 0, min: 0 },
    currentLevel: { type: Number, default: 1, min: 1 },

    // Activity
    dsaSolveCount: { type: Number, default: 0, min: 0 },
    weeklyConsistencyScore: { type: Number, default: 0, min: 0, max: 100 },

    // Weekly history
    weeklyXPHistory: {
      type: [
        {
          weekStart: { type: Date, required: true },
          xp: { type: Number, default: 0, min: 0 },
        },
      ],
      default: [],
    },

    // Placeholders
    placementReadinessScore: { type: Number, default: 0, min: 0, max: 100 },

    // Timestamps
    updatedAt: { type: Date, default: null },
    computedAt: { type: Date, default: null },
  },
  { timestamps: { updatedAt: true, createdAt: false } }
);

// Query indexes
userAnalyticsSchema.index({ currentStreak: -1 });
userAnalyticsSchema.index({ totalXp: -1 });
userAnalyticsSchema.index({ currentLevel: -1 });
userAnalyticsSchema.index({ weeklyConsistencyScore: -1 });
userAnalyticsSchema.index({ lastActiveDate: -1 });

export const UserAnalytics = mongoose.model<IUserAnalytics>('UserAnalytics', userAnalyticsSchema);