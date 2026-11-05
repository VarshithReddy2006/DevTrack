// src/db/models/betaCohort.model.ts — Beta Cohort Management
// Phase-J: Controlled Beta Infrastructure - Cohort assignment and staged feature exposure

import mongoose, { Schema, Document } from 'mongoose';

export interface IBetaCohort extends Document {
  cohortId: string;
  name: string;
  description: string;
  type: 'onboarding' | 'feature_test' | 'ux_experiment' | 'general';
  status: 'draft' | 'active' | 'paused' | 'completed';
  targetSize: number;
  currentSize: number;
  featureFlags: Record<string, boolean>;
  betaFeatures: string[];
  startDate?: Date;
  endDate?: Date;
  onboardingVariant?: string;
  priority: number;
  notes?: string;
}

const BetaCohortSchema = new Schema<IBetaCohort>({
  cohortId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String },
  type: {
    type: String,
    enum: ['onboarding', 'feature_test', 'ux_experiment', 'general'],
    default: 'general',
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'paused', 'completed'],
    default: 'draft',
  },
  targetSize: { type: Number, default: 50 },
  currentSize: { type: Number, default: 0 },
  featureFlags: { type: Map, of: Boolean, default: {} },
  betaFeatures: [{ type: String }],
  startDate: { type: Date },
  endDate: { type: Date },
  onboardingVariant: { type: String },
  priority: { type: Number, default: 0 },
  notes: { type: String },
}, {
  timestamps: true,
});

// Indexes
BetaCohortSchema.index({ status: 1 });
BetaCohortSchema.index({ type: 1 });
BetaCohortSchema.index({ priority: -1 });

export const BetaCohort = mongoose.model<IBetaCohort>('BetaCohort', BetaCohortSchema);
