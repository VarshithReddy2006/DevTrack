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

export interface IBulletEdit {
  section: string;
  bulletIndex: number;
  originalText: string;
  editedText: string;
}

export interface IVariantAtsScore {
  score: number;
  extractionConfidence: number;
  parserWarningCount: number;
  formattingWarningCount: number;
  keywordsMatched: number;
  keywordsTotal: number;
  scoredAt: Date;
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
  bulletEdits?: IBulletEdit[];
  jobTargetId?: Schema.Types.ObjectId;
  atsScore?: IVariantAtsScore;
  bulletRevisionVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

const bulletEditSchema = new Schema<IBulletEdit>(
  {
    section: { type: String, required: true, trim: true, maxlength: 50 },
    bulletIndex: { type: Number, required: true, min: 0, validate: Number.isInteger },
    originalText: { type: String, default: '', maxlength: 1000 },
    editedText: { type: String, required: true, maxlength: 1000 },
  },
  { _id: false }
);

const variantAtsScoreSchema = new Schema<IVariantAtsScore>(
  {
    score: { type: Number, required: true, min: 0, max: 100 },
    extractionConfidence: { type: Number, required: true, min: 0, max: 100 },
    parserWarningCount: { type: Number, required: true, min: 0 },
    formattingWarningCount: { type: Number, required: true, min: 0 },
    keywordsMatched: { type: Number, required: true, min: 0 },
    keywordsTotal: { type: Number, required: true, min: 0 },
    scoredAt: { type: Date, required: true },
  },
  { _id: false }
);

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
    // Absent (not empty) on variants created without the live editor, so v1 responses keep their shape.
    bulletEdits: { type: [bulletEditSchema], default: undefined },
    jobTargetId: { type: Schema.Types.ObjectId },
    atsScore: { type: variantAtsScoreSchema, default: undefined },
    bulletRevisionVersion: { type: Number, min: 0, validate: Number.isSafeInteger, default: undefined },
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
