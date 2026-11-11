import { Schema, model, type Document } from 'mongoose';

export interface ISemanticAnalysis extends Document {
  sessionId: string;
  extractedSkills: {
    languages: string[];
    frameworks: string[];
    databases: string[];
    cloudTools: string[];
    devOpsTools: string[];
    aiMlTools: string[];
  };
  experienceSignals: {
    yearsOfExperience: number;
    engineeringDepth: number;
    projectComplexity: number;
    leadershipIndicators: number;
    productionExposure: number;
  };
  roleAlignment: {
    backend: number;
    frontend: number;
    fullstack: number;
    ml: number;
    devops: number;
  };
  weaknesses: string[];
  strengths: string[];
  semanticSummary: string;
  confidenceScore: number;
  provenance?: { provider: string; model: string };
  analyzedAt: Date;
}

const semanticAnalysisSchema = new Schema<ISemanticAnalysis>(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },
    extractedSkills: {
      languages: [String],
      frameworks: [String],
      databases: [String],
      cloudTools: [String],
      devOpsTools: [String],
      aiMlTools: [String],
    },
    experienceSignals: {
      yearsOfExperience: { type: Number, required: true },
      engineeringDepth: { type: Number, required: true },
      projectComplexity: { type: Number, required: true },
      leadershipIndicators: { type: Number, required: true },
      productionExposure: { type: Number, required: true },
    },
    roleAlignment: {
      backend: { type: Number, required: true },
      frontend: { type: Number, required: true },
      fullstack: { type: Number, required: true },
      ml: { type: Number, required: true },
      devops: { type: Number, required: true },
    },
    weaknesses: [String],
    strengths: [String],
    semanticSummary: { type: String, required: true },
    confidenceScore: { type: Number, required: true },
    provenance: { provider: String, model: String },
    analyzedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

export const SemanticAnalysis = model<ISemanticAnalysis>('SemanticAnalysis', semanticAnalysisSchema);
