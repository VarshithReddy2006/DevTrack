// src/db/models/userXp.model.ts — User XP aggregate state
// Tracks total XP, current level, lifetime stats.
// Aggregate is kept in sync via XpTransaction inserts (never recalculated).

import mongoose, { Schema, type Document } from 'mongoose';

export interface IUserXp extends Document {
  userId: Schema.Types.ObjectId;
  totalXp: number;
  currentLevel: number;
  xpToNextLevel: number;
  lastXpGainedAt: Date | null;
  lifetimeStats: {
    totalProblemsSolved: number;
    easySolved: number;
    mediumSolved: number;
    hardSolved: number;
    totalContests: number;
    dailyStreaks: number;
    longestStreak: number;
    totalSyncs: number;
    totalXpEarned: number;
  };
  updatedAt: Date;
}

const userXpSchema = new Schema<IUserXp>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true },
    totalXp: { type: Number, default: 0, min: 0 },
    currentLevel: { type: Number, default: 1, min: 1 },
    xpToNextLevel: { type: Number, default: 100, min: 0 },
    lastXpGainedAt: { type: Date, default: null },
    lifetimeStats: {
      totalProblemsSolved: { type: Number, default: 0, min: 0 },
      easySolved: { type: Number, default: 0, min: 0 },
      mediumSolved: { type: Number, default: 0, min: 0 },
      hardSolved: { type: Number, default: 0, min: 0 },
      totalContests: { type: Number, default: 0, min: 0 },
      dailyStreaks: { type: Number, default: 0, min: 0 },
      longestStreak: { type: Number, default: 0, min: 0 },
      totalSyncs: { type: Number, default: 0, min: 0 },
      totalXpEarned: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: { updatedAt: true } }
);

userXpSchema.index({ totalXp: -1 }); // leaderboard index
userXpSchema.index({ currentLevel: -1 });

export const UserXp = mongoose.model<IUserXp>('UserXp', userXpSchema);