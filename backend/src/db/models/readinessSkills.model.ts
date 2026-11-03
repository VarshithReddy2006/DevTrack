import mongoose, { Schema, Document } from 'mongoose';

export interface IReadinessSkills extends Document {
  userId: string;
  domains: Array<{
    name: string; // e.g., 'frontend', 'backend', 'databases', 'cloud'
    maturity: number; // 0-100
    practicalExposure: number; // 0-100
    productionRelevance: number; // 0-100
    recency: Date;
    consistency: number;
    verifiedSkills: string[];
    missingSkills: string[];
  }>;
  overallEngineeringDepth: number; // 0-100
  
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

const ReadinessSkillsSchema = new Schema<IReadinessSkills>(
  {
    userId: { type: String, required: true, unique: true },
    domains: [
      {
        name: { type: String },
        maturity: { type: Number },
        practicalExposure: { type: Number },
        productionRelevance: { type: Number },
        recency: { type: Date },
        consistency: { type: Number },
        verifiedSkills: [{ type: String }],
        missingSkills: [{ type: String }],
      }
    ],
    overallEngineeringDepth: { type: Number, default: 0 },
    
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

export const ReadinessSkills = mongoose.model<IReadinessSkills>('ReadinessSkills', ReadinessSkillsSchema);
