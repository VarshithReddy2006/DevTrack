import mongoose, { Schema, Document } from 'mongoose';

export interface IReadinessCore extends Document {
  userId: string;
  overallScore: number;
  confidence: number;
  trustWeight: number;
  targetRoleAlignment: number; // 0-100
  momentumTrend: 'improving' | 'stagnating' | 'declining';
  progressionState: string; // e.g. Early Backend Foundation, Production Engineering, etc.
  
  // Temporal & Deterministic Versioning
  snapshotVersion: string;
  analyticsVersion: string;
  graphVersion: string;
  scoringVersion: string;
  computedAt: Date;

  // Confidence & Evidence System
  confidenceScore: number; // 0-100
  confidenceReasoning: string;
  evidenceCoverage: number; // 0-100
  providerFreshness: Record<string, { lastSync: Date; freshnessScore: number }>;

  // Degraded Mode Flags
  isDegraded: boolean;
  staleProviders: string[];
  missingPillars?: string[];
  completeness?: number;

  // Future Architecture
  verifiedPrivateContributionsEnabled: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const ReadinessCoreSchema = new Schema<IReadinessCore>(
  {
    userId: { type: String, required: true, unique: true },
    overallScore: { type: Number, default: 0 },
    confidence: { type: Number, default: 0 },
    trustWeight: { type: Number, default: 1.0 },
    targetRoleAlignment: { type: Number, default: 0 },
    momentumTrend: { type: String, enum: ['improving', 'stagnating', 'declining'], default: 'stagnating' },
    progressionState: { type: String, default: 'Discovery & Foundation' },
    
    snapshotVersion: { type: String, default: '1.0.0' },
    analyticsVersion: { type: String, default: '1.0.0' },
    graphVersion: { type: String, default: '1.0.0' },
    scoringVersion: { type: String, default: '1.0.0' },
    computedAt: { type: Date, default: Date.now },

    confidenceScore: { type: Number, default: 0 },
    confidenceReasoning: { type: String, default: '' },
    evidenceCoverage: { type: Number, default: 0 },
    providerFreshness: {
      type: Map,
      of: {
        lastSync: Date,
        freshnessScore: Number
      },
      default: {}
    },

    isDegraded: { type: Boolean, default: false },
    staleProviders: [{ type: String }],
    missingPillars: [{ type: String }],
    completeness: { type: Number, min: 0, max: 100 },
    
    verifiedPrivateContributionsEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const ReadinessCore = mongoose.model<IReadinessCore>('ReadinessCore', ReadinessCoreSchema);
