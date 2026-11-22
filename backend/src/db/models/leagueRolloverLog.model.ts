// src/db/models/leagueRolloverLog.model.ts — Durable checkpoint ledger for weekly league rollover sagas.
//
// Records cohort-level execution status (pending, in_progress, committed, compensated, failed)
// and step progression to guarantee crash-recovery, idempotency, and rollback safety.

import mongoose, { Schema, type Document } from 'mongoose';
import { LEAGUE_DIVISIONS, type LeagueDivision, type LeagueOutcome } from './leagueStanding.model.js';

export const SAGA_COHORT_STATUSES = ['pending', 'in_progress', 'committed', 'compensated', 'failed'] as const;
export type SagaCohortStatus = (typeof SAGA_COHORT_STATUSES)[number];

export const SAGA_COHORT_STEPS = [
  'snapshot_scores',
  'compute_outcomes',
  'persist_standings',
  'seed_next_cohorts',
] as const;
export type SagaCohortStep = (typeof SAGA_COHORT_STEPS)[number];

export interface ILeagueRolloverSnapshotMember {
  userId: string;
  rank?: number | null;
  points: number;
  cohortSize?: number | null;
  outcome?: LeagueOutcome | null;
  nextDivision?: LeagueDivision | null;
}

export interface ILeagueRolloverError {
  message: string;
  step: string;
  occurredAt: Date;
  stack?: string;
}

export interface ILeagueRolloverLog extends Document {
  weekKey: string;
  division: LeagueDivision;
  cohortId: string;
  idempotencyKey: string;
  status: SagaCohortStatus;
  currentStep: SagaCohortStep;
  snapshot?: {
    board: Array<{ userId: string; points: number }>;
    standings: ILeagueRolloverSnapshotMember[];
  };
  error?: ILeagueRolloverError | null;
  attempts: number;
  startedAt: Date;
  completedAt?: Date | null;
  compensatedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const leagueRolloverLogSchema = new Schema<ILeagueRolloverLog>(
  {
    weekKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    division: { type: String, required: true, enum: LEAGUE_DIVISIONS },
    cohortId: { type: String, required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    status: { type: String, required: true, enum: SAGA_COHORT_STATUSES, default: 'pending' },
    currentStep: { type: String, required: true, enum: SAGA_COHORT_STEPS, default: 'snapshot_scores' },
    snapshot: {
      board: [
        {
          userId: { type: String, required: true },
          points: { type: Number, required: true },
        },
      ],
      standings: [
        {
          userId: { type: String, required: true },
          rank: { type: Number, default: null },
          points: { type: Number, required: true },
          cohortSize: { type: Number, default: null },
          outcome: { type: String, enum: ['promoted', 'demoted', 'stayed', null], default: null },
          nextDivision: { type: String, enum: [...LEAGUE_DIVISIONS, null], default: null },
        },
      ],
    },
    error: {
      type: new Schema(
        {
          message: { type: String },
          step: { type: String },
          occurredAt: { type: Date },
          stack: { type: String },
        },
        { _id: false },
      ),
      default: null,
    },
    attempts: { type: Number, default: 0 },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    compensatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Indexes
leagueRolloverLogSchema.index({ weekKey: 1, division: 1, cohortId: 1 }, { unique: true, name: 'uq_league_rollover_cohort' });
leagueRolloverLogSchema.index({ weekKey: 1, status: 1 }, { name: 'idx_league_rollover_week_status' });

export const LeagueRolloverLog = mongoose.model<ILeagueRolloverLog>('LeagueRolloverLog', leagueRolloverLogSchema);
