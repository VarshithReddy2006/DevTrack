// src/db/models/resumeEvidenceClaim.model.ts
import { Schema, model, type Document } from 'mongoose';

export type VerificationStatus = 'verified' | 'partial' | 'unverified' | 'flagged';
export type ProvenanceType = 'github' | 'project' | 'dsa' | 'infra' | 'manual' | 'ai_assisted';

export interface IEvidenceSource {
  type: ProvenanceType;
  referenceId: string;
  referenceType: string;
  metadata: Record<string, unknown>;
}

export interface IResumeEvidenceClaim extends Document {
  userId: Schema.Types.ObjectId;
  resumeProfileId: Schema.Types.ObjectId;
  variantId: string | null;
  claimText: string;
  evidenceSources: IEvidenceSource[];
  verificationStatus: VerificationStatus;
  provenance: ProvenanceType[];
  confidence: number;
  generatedBy: 'deterministic' | 'ai_assisted' | 'manual';
  metadata: {
    lastVerifiedAt: Date | null;
    verificationAttempts: number;
    flaggedReason: string | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const evidenceSourceSchema = new Schema<IEvidenceSource>(
  {
    type: {
      type: String,
      enum: ['github', 'project', 'dsa', 'infra', 'manual', 'ai_assisted'],
      required: true,
    },
    referenceId: {
      type: String,
      required: true,
    },
    referenceType: {
      type: String,
      required: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { _id: false }
);

const resumeEvidenceClaimSchema = new Schema<IResumeEvidenceClaim>(
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
      default: null,
    },
    claimText: {
      type: String,
      required: true,
      trim: true,
    },
    evidenceSources: {
      type: [evidenceSourceSchema],
      default: [],
    },
    verificationStatus: {
      type: String,
      enum: ['verified', 'partial', 'unverified', 'flagged'],
      default: 'unverified',
      index: true,
    },
    provenance: {
      type: [String],
      enum: ['github', 'project', 'dsa', 'infra', 'manual', 'ai_assisted'],
      default: [],
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    generatedBy: {
      type: String,
      enum: ['deterministic', 'ai_assisted', 'manual'],
      required: true,
      default: 'deterministic',
    },
    metadata: {
      lastVerifiedAt: { type: Date, default: null },
      verificationAttempts: { type: Number, default: 0 },
      flaggedReason: { type: String, default: null },
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
resumeEvidenceClaimSchema.index({ userId: 1, verificationStatus: 1 });
resumeEvidenceClaimSchema.index({ resumeProfileId: 1 });
resumeEvidenceClaimSchema.index({ variantId: 1 });
resumeEvidenceClaimSchema.index({ confidence: -1 });

export const ResumeEvidenceClaim = model<IResumeEvidenceClaim>('ResumeEvidenceClaim', resumeEvidenceClaimSchema);
