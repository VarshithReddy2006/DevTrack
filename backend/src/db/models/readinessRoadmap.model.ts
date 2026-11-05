import mongoose, { Schema, Document } from 'mongoose';

export interface IReadinessRoadmap extends Document {
  userId: string;
  verifiedNodes: Array<{
    nodeId: string;
    verifiedAt: Date;
    evidenceLinks: string[];
    maturityWeighting: number;
  }>;
  missingDependencies: Array<{
    nodeId: string;
    importance: 'critical' | 'high' | 'medium' | 'low';
    reasoning: string;
  }>;
  nextBestActions: Array<{
    actionType: string;
    description: string;
    targetNodeId?: string;
  }>;
  
  // Confidence & Evidence System
  confidenceScore: number; // 0-100
  confidenceReasoning: string;
  evidenceCoverage: number; // 0-100
  
  // Temporal & Deterministic Versioning
  snapshotVersion: string;
  graphVersion: string;
  computedAt: Date;
  
  createdAt: Date;
  updatedAt: Date;
}

const ReadinessRoadmapSchema = new Schema<IReadinessRoadmap>(
  {
    userId: { type: String, required: true, unique: true },
    verifiedNodes: [
      {
        nodeId: { type: String },
        verifiedAt: { type: Date },
        evidenceLinks: [{ type: String }],
        maturityWeighting: { type: Number },
      }
    ],
    missingDependencies: [
      {
        nodeId: { type: String },
        importance: { type: String, enum: ['critical', 'high', 'medium', 'low'] },
        reasoning: { type: String },
      }
    ],
    nextBestActions: [
      {
        actionType: { type: String },
        description: { type: String },
        targetNodeId: { type: String },
      }
    ],
    
    confidenceScore: { type: Number, default: 0 },
    confidenceReasoning: { type: String, default: '' },
    evidenceCoverage: { type: Number, default: 0 },
    
    snapshotVersion: { type: String, default: '1.0.0' },
    graphVersion: { type: String, default: '1.0.0' },
    computedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const ReadinessRoadmap = mongoose.model<IReadinessRoadmap>('ReadinessRoadmap', ReadinessRoadmapSchema);
