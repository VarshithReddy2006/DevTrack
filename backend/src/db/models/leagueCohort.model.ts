// src/db/models/leagueCohort.model.ts — Atomic cohort capacity metadata for late-joiner placement.
// Tracks active member counts per (weekKey, division, cohortId) so concurrent registrations
// reserve slots atomically via conditional $inc without exceeding TARGET_COHORT_SIZE.

import mongoose, { Schema, type Document } from 'mongoose';
import { LEAGUE_DIVISIONS, type LeagueDivision } from './leagueStanding.model.js';

export interface ILeagueCohort extends Document {
  weekKey: string;
  division: LeagueDivision;
  cohortId: string;
  cohortIndex: number;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const leagueCohortSchema = new Schema<ILeagueCohort>(
  {
    weekKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    division: { type: String, required: true, enum: LEAGUE_DIVISIONS },
    cohortId: { type: String, required: true },
    cohortIndex: { type: Number, required: true, min: 1 },
    memberCount: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

leagueCohortSchema.index(
  { weekKey: 1, division: 1, cohortId: 1 },
  { name: 'uq_leaguecohorts_week_div_cohort', unique: true },
);
leagueCohortSchema.index(
  { weekKey: 1, division: 1, memberCount: 1, cohortIndex: 1 },
  { name: 'idx_leaguecohorts_available' },
);

export const LeagueCohort = mongoose.model<ILeagueCohort>('LeagueCohort', leagueCohortSchema);
