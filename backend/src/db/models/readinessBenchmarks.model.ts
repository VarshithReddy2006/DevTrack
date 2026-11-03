import mongoose, { Schema, Document } from 'mongoose';

export interface IReadinessBenchmarks extends Document {
  userId: string;
  cohortSegments: Array<{
    cohortId: string;
    cohortName: string; // e.g., 'Backend Aspirants', 'FAANG-focused'
    percentileRanking: number; // 0-100
    sampleSize: number;
    confidenceLevel: 'high' | 'medium' | 'low';
    freshnessTimestamp: Date;
    relativeComparisons: Array<{
      metricName: string;
      userValue: number;
      cohortAverage: number;
      status: 'above' | 'average' | 'below';
    }>;
  }>;
  
  // Confidence & Evidence System
  confidenceScore: number; // 0-100
  confidenceReasoning: string;
  evidenceCoverage: number; // 0-100
  
  // Temporal & Deterministic Versioning
  snapshotVersion: string;
  analyticsVersion: string;
  computedAt: Date;
  
  createdAt: Date;
  updatedAt: Date;
}

const ReadinessBenchmarksSchema = new Schema<IReadinessBenchmarks>(
  {
    userId: { type: String, required: true, unique: true },
    cohortSegments: [
      {
        cohortId: { type: String },
        cohortName: { type: String },
        percentileRanking: { type: Number },
        sampleSize: { type: Number },
        confidenceLevel: { type: String, enum: ['high', 'medium', 'low'] },
        freshnessTimestamp: { type: Date },
        relativeComparisons: [
          {
            metricName: { type: String },
            userValue: { type: Number },
            cohortAverage: { type: Number },
            status: { type: String, enum: ['above', 'average', 'below'] },
          }
        ]
      }
    ],
    
    confidenceScore: { type: Number, default: 0 },
    confidenceReasoning: { type: String, default: '' },
    evidenceCoverage: { type: Number, default: 0 },
    
    snapshotVersion: { type: String, default: '1.0.0' },
    analyticsVersion: { type: String, default: '1.0.0' },
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const ReadinessBenchmarks = mongoose.model<IReadinessBenchmarks>('ReadinessBenchmarks', ReadinessBenchmarksSchema);
