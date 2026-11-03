// src/db/models/resumeVariant.model.ts
import { Schema, model, type Document } from 'mongoose';

export type RoleType = 'Backend' | 'Full Stack' | 'Frontend' | 'Infrastructure' | 'Startup' | 'Product Engineering';

export interface IWeightingProfile {
  infraWeight: number;
  systemDesignWeight: number;
  dsaWeight: number;
  projectComplexityWeight: number;
  leadershipWeight: number;
}

export interface IResumeVariant extends Document {
  userId: Schema.Types.ObjectId;
  resumeProfileId: Schema.Types.ObjectId;
  variantId: string;
  roleType: RoleType;
  weightingProfile: IWeightingProfile;
  prioritizedProjects: Schema.Types.ObjectId[];
  prioritizedSkills: string[];
  infraWeight: number;
  atsMetadata: {
    keywordDensity: Record<string, number>;
    sectionOrder: string[];
    formattingRules: string[];
  };
  exportMetadata: {
    lastExportedAt: Date | null;
    exportCount: number;
    preferredFormat: string;
  };
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

const resumeVariantSchema = new Schema<IResumeVariant>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    resumeProfileId: {
      type: Schema.Types.ObjectId,
      ref: 'ResumeProfile',
      required: true,
    },
    variantId: {
      type: String,
      required: true,
      unique: true,
    },
    roleType: {
      type: String,
      enum: ['Backend', 'Full Stack', 'Frontend', 'Infrastructure', 'Startup', 'Product Engineering'],
      required: true,
    },
    weightingProfile: {
      infraWeight: { type: Number, default: 0.2, min: 0, max: 1 },
      systemDesignWeight: { type: Number, default: 0.3, min: 0, max: 1 },
      dsaWeight: { type: Number, default: 0.2, min: 0, max: 1 },
      projectComplexityWeight: { type: Number, default: 0.2, min: 0, max: 1 },
      leadershipWeight: { type: Number, default: 0.1, min: 0, max: 1 },
    },
    prioritizedProjects: [{
      type: Schema.Types.ObjectId,
      ref: 'Project',
    }],
    prioritizedSkills: {
      type: [String],
      default: [],
    },
    infraWeight: {
      type: Number,
      default: 0.2,
      min: 0,
      max: 1,
    },
    atsMetadata: {
      keywordDensity: {
        type: Map,
        of: Number,
        default: {},
      },
      sectionOrder: {
        type: [String],
        default: ['summary', 'experience', 'projects', 'skills', 'education'],
      },
      formattingRules: {
        type: [String],
        default: [],
      },
    },
    exportMetadata: {
      lastExportedAt: { type: Date, default: null },
      exportCount: { type: Number, default: 0 },
      preferredFormat: { type: String, default: 'pdf' },
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
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
resumeVariantSchema.index({ userId: 1, roleType: 1 });
resumeVariantSchema.index({ resumeProfileId: 1 });

export const ResumeVariant = model<IResumeVariant>('ResumeVariant', resumeVariantSchema);
