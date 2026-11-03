import mongoose, { Schema, Document } from 'mongoose';

export interface IReadinessDsa extends Document {
  userId: string;
  totalSolves: number;
  hardProblemProgression: number;
  solveConsistency: number; // 0-100
  difficultyDistribution: {
    easy: number;
    medium: number;
    hard: number;
  };
  topics: Array<{
    name: string;
    masteryLevel: number; // 0-100
    confidenceScore: number; // 0-100
    evidenceCoverage: number; // 0-100
    progressionTrend: 'improving' | 'stagnating' | 'declining';
    hardLevelMaturity: number;
    recency: Date;
    consistency: number;
  }>;
  weakTopics: string[];
  neglectedTopics: string[];
  
  // Confidence & Evidence System
  confidenceScore: number; // 0-100
  confidenceReasoning: string;
  evidenceCoverage: number; // 0-100
  providerFreshness: Record<string, { lastSync: Date; freshnessScore: number }>;
  
  // Temporal & Deterministic Versioning
  snapshotVersion: string;
  analyticsVersion: string;
  computedAt: Date;
  
  createdAt: Date;
  updatedAt: Date;
}

const ReadinessDsaSchema = new Schema<IReadinessDsa>(
  {
    userId: { type: String, required: true, unique: true },
    totalSolves: { type: Number, default: 0 },
    hardProblemProgression: { type: Number, default: 0 },
    solveConsistency: { type: Number, default: 0 },
    difficultyDistribution: {
      easy: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      hard: { type: Number, default: 0 },
    },
    topics: [
      {
        name: { type: String },
        masteryLevel: { type: Number },
        confidenceScore: { type: Number },
        evidenceCoverage: { type: Number },
        progressionTrend: { type: String, enum: ['improving', 'stagnating', 'declining'] },
        hardLevelMaturity: { type: Number },
        recency: { type: Date },
        consistency: { type: Number },
      }
    ],
    weakTopics: [{ type: String }],
    neglectedTopics: [{ type: String }],
    
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
    
    snapshotVersion: { type: String, default: '1.0.0' },
    analyticsVersion: { type: String, default: '1.0.0' },
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const ReadinessDsa = mongoose.model<IReadinessDsa>('ReadinessDsa', ReadinessDsaSchema);
