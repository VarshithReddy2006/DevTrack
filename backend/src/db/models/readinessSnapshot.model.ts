import { Schema, model, type Types } from 'mongoose';
import type { CompositeReadinessScore } from '../../modules/readiness/readinessScore.calculation.js';

export interface IWeeklyReadinessSnapshot {
  _id: string;
  userId: Types.ObjectId;
  weekStart: Date;
  scoringVersion: string;
  computedAt: Date;
  overallScore: number;
  dsaScore: number;
  systemDesignScore: number;
  projectScore: number;
  interviewScore: number;
  /** Validated/versioned response, preserving provenance and missing-evidence explanations. */
  result: CompositeReadinessScore;
}
const score = { type: Number, required: true, min: 0, max: 1000 };
const schema = new Schema<IWeeklyReadinessSnapshot>({
  _id: { type: String, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  weekStart: { type: Date, required: true }, scoringVersion: { type: String, required: true },
  computedAt: { type: Date, required: true },
  overallScore: score, dsaScore: score, systemDesignScore: score, projectScore: score, interviewScore: score,
  result: { type: Schema.Types.Mixed, required: true },
}, { versionKey: false });
schema.index({ userId: 1, weekStart: 1, scoringVersion: 1 }, { unique: true, name: 'uq_readiness_user_week_version' });
export const ReadinessSnapshot = model<IWeeklyReadinessSnapshot>('ReadinessSnapshot', schema);

export const readinessSnapshotId = (userId: string, weekStart: string, version: string) => `${version}:${userId}:${weekStart}`;
