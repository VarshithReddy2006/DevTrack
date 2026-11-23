// src/db/models/leagueStanding.model.ts — Weekly league membership and final standings.
// A row is created as 'active' when a user is placed in a cohort for a week and is
// flipped to 'finalized' (rank, points, outcome) by the Sunday rollover. The live
// score for an active week lives in a Redis sorted set; this collection is the
// durable record and the source of truth for who is in which cohort.

import mongoose, { Schema, type Document, type Types } from 'mongoose';
import { LEAGUE_STANDING_INDEXES } from './leagueStandingIndexes.js';

export const LEAGUE_DIVISIONS = [
  'bronze',
  'silver',
  'gold',
  'platinum',
  'diamond',
  'master',
  'grandmaster',
] as const;
export type LeagueDivision = (typeof LEAGUE_DIVISIONS)[number];

export type LeagueStandingStatus = 'active' | 'finalized';
export type LeagueOutcome = 'promoted' | 'demoted' | 'stayed';

export interface ILeagueStanding extends Document {
  /** UTC date (YYYY-MM-DD) of the Sunday that starts the week. */
  weekKey: string;
  userId: Types.ObjectId;
  division: LeagueDivision;
  cohortId: string;
  status: LeagueStandingStatus;
  /** Only XP awarded at or after this instant counts toward the week. */
  joinedAt: Date;
  /** Final points; 0 until the week is finalized. */
  points: number;
  rank: number | null;
  cohortSize: number | null;
  outcome: LeagueOutcome | null;
  nextDivision: LeagueDivision | null;
  finalizedAt: Date | null;
  notifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const leagueStandingSchema = new Schema<ILeagueStanding>(
  {
    weekKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    division: { type: String, required: true, enum: LEAGUE_DIVISIONS },
    cohortId: { type: String, required: true },
    status: { type: String, required: true, enum: ['active', 'finalized'], default: 'active' },
    joinedAt: { type: Date, required: true },
    points: { type: Number, default: 0, min: 0 },
    rank: { type: Number, default: null, min: 1 },
    cohortSize: { type: Number, default: null, min: 1 },
    outcome: { type: String, enum: ['promoted', 'demoted', 'stayed', null], default: null },
    nextDivision: { type: String, enum: [...LEAGUE_DIVISIONS, null], default: null },
    finalizedAt: { type: Date, default: null },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

for (const { key, options } of LEAGUE_STANDING_INDEXES) {
  leagueStandingSchema.index(key, options);
}

export const LeagueStanding = mongoose.model<ILeagueStanding>('LeagueStanding', leagueStandingSchema);
