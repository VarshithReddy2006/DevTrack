import mongoose, { Schema, Document } from 'mongoose';

export interface IReadinessProjects extends Document {
  userId: string;
  projectCredibilityScore: number; // 0-100
  infrastructureSophistication: number; // 0-100
  engineeringMaturity: number; // 0-100
  deploymentEvidence: number; // 0-100
  complexityMetrics: {
    architectureSophistication: number;
    scalabilityExposure: number;
    repositoryQuality: number;
    contributionConsistency: number;
    operationalComplexity: number;
  };
  systemDesignSignals: {
    hasRedis: boolean;
    hasBullMQ: boolean;
    hasDocker: boolean;
    hasQueueSystems: boolean;
    hasSSEWebSockets: boolean;
    hasMonitoring: boolean;
    hasCDN: boolean;
    hasDeploymentPipelines: boolean;
    hasInfraOrchestration: boolean;
    hasCaching: boolean;
  };
  communicationSignals: {
    documentationQuality: number; // 0-100
    technicalExplanationClarity: number; // 0-100
    communicationMaturity: number; // 0-100
  };
  
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

const ReadinessProjectsSchema = new Schema<IReadinessProjects>(
  {
    userId: { type: String, required: true, unique: true },
    projectCredibilityScore: { type: Number, default: 0 },
    infrastructureSophistication: { type: Number, default: 0 },
    engineeringMaturity: { type: Number, default: 0 },
    deploymentEvidence: { type: Number, default: 0 },
    complexityMetrics: {
      architectureSophistication: { type: Number, default: 0 },
      scalabilityExposure: { type: Number, default: 0 },
      repositoryQuality: { type: Number, default: 0 },
      contributionConsistency: { type: Number, default: 0 },
      operationalComplexity: { type: Number, default: 0 },
    },
    systemDesignSignals: {
      hasRedis: { type: Boolean, default: false },
      hasBullMQ: { type: Boolean, default: false },
      hasDocker: { type: Boolean, default: false },
      hasQueueSystems: { type: Boolean, default: false },
      hasSSEWebSockets: { type: Boolean, default: false },
      hasMonitoring: { type: Boolean, default: false },
      hasCDN: { type: Boolean, default: false },
      hasDeploymentPipelines: { type: Boolean, default: false },
      hasInfraOrchestration: { type: Boolean, default: false },
      hasCaching: { type: Boolean, default: false },
    },
    communicationSignals: {
      documentationQuality: { type: Number, default: 0 },
      technicalExplanationClarity: { type: Number, default: 0 },
      communicationMaturity: { type: Number, default: 0 },
    },
    
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

export const ReadinessProjects = mongoose.model<IReadinessProjects>('ReadinessProjects', ReadinessProjectsSchema);
