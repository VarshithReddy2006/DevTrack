// src/db/models/resumeProfile.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IResumeProfile extends Document {
  userId: Schema.Types.ObjectId;
  targetRole: string;
  activeVariant: string | null;
  summary: string;
  selectedProjects: Schema.Types.ObjectId[];
  selectedSkills: string[];
  infraSignals: {
    dockerUsage: boolean;
    cicdPipeline: boolean;
    cloudDeployment: boolean;
    monitoring: boolean;
    testing: boolean;
    score: number;
  };
  systemDesignSignals: {
    architectureComplexity: number;
    scalabilityEvidence: boolean;
    distributedSystems: boolean;
    score: number;
  };
  dsaSignals: {
    problemsSolved: number;
    contestsParticipated: number;
    averageDifficulty: string;
    score: number;
  };
  atsScore: number;
  credibilityScore: number;
  readinessLinkage: {
    overallReadiness: number;
    technicalReadiness: number;
    projectReadiness: number;
  };
  generatedVariants: string[];
  exportHistory: Schema.Types.ObjectId[];
  metadata: {
    lastGeneratedAt: Date | null;
    generationCount: number;
    lastExportedAt: Date | null;
    exportCount: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const resumeProfileSchema = new Schema<IResumeProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    targetRole: {
      type: String,
      default: 'Full Stack Developer',
      trim: true,
    },
    activeVariant: {
      type: String,
      default: null,
    },
    summary: {
      type: String,
      default: '',
    },
    selectedProjects: [{
      type: Schema.Types.ObjectId,
      ref: 'Project',
    }],
    selectedSkills: {
      type: [String],
      default: [],
    },
    infraSignals: {
      dockerUsage: { type: Boolean, default: false },
      cicdPipeline: { type: Boolean, default: false },
      cloudDeployment: { type: Boolean, default: false },
      monitoring: { type: Boolean, default: false },
      testing: { type: Boolean, default: false },
      score: { type: Number, default: 0, min: 0, max: 100 },
    },
    systemDesignSignals: {
      architectureComplexity: { type: Number, default: 0, min: 0, max: 10 },
      scalabilityEvidence: { type: Boolean, default: false },
      distributedSystems: { type: Boolean, default: false },
      score: { type: Number, default: 0, min: 0, max: 100 },
    },
    dsaSignals: {
      problemsSolved: { type: Number, default: 0 },
      contestsParticipated: { type: Number, default: 0 },
      averageDifficulty: { type: String, default: 'easy' },
      score: { type: Number, default: 0, min: 0, max: 100 },
    },
    atsScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    credibilityScore: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    readinessLinkage: {
      overallReadiness: { type: Number, default: 0, min: 0, max: 100 },
      technicalReadiness: { type: Number, default: 0, min: 0, max: 100 },
      projectReadiness: { type: Number, default: 0, min: 0, max: 100 },
    },
    generatedVariants: {
      type: [String],
      default: [],
    },
    exportHistory: [{
      type: Schema.Types.ObjectId,
      ref: 'ResumeExport',
    }],
    metadata: {
      lastGeneratedAt: { type: Date, default: null },
      generationCount: { type: Number, default: 0 },
      lastExportedAt: { type: Date, default: null },
      exportCount: { type: Number, default: 0 },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete (ret as { _id?: unknown })._id;
        delete (ret as { __v?: unknown }).__v;
        return ret;
      },
    },
  }
);

// Indexes
resumeProfileSchema.index({ credibilityScore: -1 });
resumeProfileSchema.index({ atsScore: -1 });

export const ResumeProfile = model<IResumeProfile>('ResumeProfile', resumeProfileSchema);
