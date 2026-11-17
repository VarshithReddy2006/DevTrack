// src/db/models/resumeEvidenceClaim.model.ts
import { Schema, model, type Document, type Types } from 'mongoose';
import { EVIDENCE_LEDGER_INDEX } from './evidenceLedgerIndex.js';

export const VERIFICATION_STATUSES = ['verified', 'partial', 'unverified', 'flagged'] as const;
export const EVIDENCE_SUBJECT_TYPES = ['resume_claim', 'repo', 'dsa_rating', 'focus_consistency', 'certification'] as const;
export const EVIDENCE_SOURCES = ['github', 'leetcode', 'codeforces', 'devtrack_focus', 'user'] as const;

// A missing subject type identifies claims written by legacy versions.
export const resumeClaimScope = { subjectType: { $in: ['resume_claim', null] } };

export type EvidenceSubjectType = typeof EVIDENCE_SUBJECT_TYPES[number];
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];

export type VerificationStatus = typeof VERIFICATION_STATUSES[number];
export type ProvenanceType = 'github' | 'project' | 'dsa' | 'infra' | 'manual' | 'ai_assisted';

export interface IEvidenceSource {
  type: ProvenanceType;
  referenceId: string;
  referenceType: string;
  metadata: Record<string, unknown>;
}

export interface EvidenceEdge {
  sourceModel: 'VerifiedProject' | 'PlatformStats' | 'ResumeSession';
  sourceId: string;
  relationship: 'verified_repository' | 'synced_platform_stats' | 'resume_origin';
  weight: number;
}

export interface IResumeEvidenceClaim extends Document {
  userId: Schema.Types.ObjectId;
  resumeProfileId?: Types.ObjectId;
  subjectType: EvidenceSubjectType;
  subjectKey?: string;
  source: EvidenceSource;
  sourceUrl?: string;
  fetchedAt?: Date;
  staleAfter?: Date;
  variantId: string | null;
  claimText: string;
  evidenceSources: IEvidenceSource[];
  lineage?: EvidenceEdge[];
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

const evidenceEdgeSchema = new Schema<EvidenceEdge>({
  sourceModel: { type: String, enum: ['VerifiedProject', 'PlatformStats', 'ResumeSession'], required: true },
  sourceId: { type: String, required: true },
  relationship: { type: String, enum: ['verified_repository', 'synced_platform_stats', 'resume_origin'], required: true },
  weight: { type: Number, min: 0, max: 100, required: true },
}, { _id: false });

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
      required: function (this: IResumeEvidenceClaim) { return this.subjectType === 'resume_claim'; },
    },
    subjectType: { type: String, enum: EVIDENCE_SUBJECT_TYPES, required: true, default: 'resume_claim' },
    subjectKey: { type: String, required: true, trim: true },
    source: { type: String, enum: EVIDENCE_SOURCES, required: true, default: 'user' },
    sourceUrl: {
      type: String,
      trim: true,
      validate: (value: string) => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' || url.protocol === 'http:';
        } catch {
          return false;
        }
      },
    },
    fetchedAt: { type: Date },
    staleAfter: { type: Date },
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
    lineage: { type: [evidenceEdgeSchema], default: undefined, select: false },
    verificationStatus: {
      type: String,
      enum: VERIFICATION_STATUSES,
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

resumeEvidenceClaimSchema.pre('validate', function () {
  if (this.subjectType === 'resume_claim' && this.subjectKey === undefined) {
    this.subjectKey = 'resume:' + this._id.toString();
  }
});

// Indexes
resumeEvidenceClaimSchema.index(EVIDENCE_LEDGER_INDEX.key, EVIDENCE_LEDGER_INDEX.options);
resumeEvidenceClaimSchema.index({ userId: 1, verificationStatus: 1 });
resumeEvidenceClaimSchema.index({ resumeProfileId: 1 });
resumeEvidenceClaimSchema.index({ variantId: 1 });
resumeEvidenceClaimSchema.index({ confidence: -1 });

export const ResumeEvidenceClaim = model<IResumeEvidenceClaim>('ResumeEvidenceClaim', resumeEvidenceClaimSchema);
