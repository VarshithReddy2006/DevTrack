import mongoose, { Schema, type Document } from 'mongoose';

export interface IZkpProofPayload {
  commitment: string;
  bitCommitments: string[];
  announcements: Array<{ a0: string; a1: string }>;
  responses: Array<{ e0: string; e1: string; s0: string; s1: string }>;
}

export interface IZkpPublicSignals {
  claimType: string;
  operator: string;
  threshold: number;
  sessionNonce: string;
  issuedAt: string;
  commitment: string;
}

export interface IVerifiedClaimProof extends Document {
  proofId: string;
  userId: string;
  claimType: string;
  operator: string;
  threshold: number;
  commitment: string;
  sessionNonce: string;
  verificationKeyId: string;
  proof: IZkpProofPayload;
  publicSignals: IZkpPublicSignals;
  verifiedCount: number;
  lastVerifiedAt: Date | null;
  expiresAt: Date;
  status: 'active' | 'revoked' | 'expired';
  createdAt: Date;
  updatedAt: Date;
}

const verifiedClaimProofSchema = new Schema<IVerifiedClaimProof>(
  {
    proofId: {
      type: String,
      required: true,
      unique: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    claimType: {
      type: String,
      required: true,
      index: true,
    },
    operator: {
      type: String,
      required: true,
      default: '>=',
    },
    threshold: {
      type: Number,
      required: true,
    },
    commitment: {
      type: String,
      required: true,
    },
    sessionNonce: {
      type: String,
      required: true,
      unique: true,
    },
    verificationKeyId: {
      type: String,
      required: true,
      default: 'devtrack-zkp-v1-secp256k1',
    },
    proof: {
      type: Schema.Types.Mixed,
      required: true,
    },
    publicSignals: {
      type: Schema.Types.Mixed,
      required: true,
    },
    verifiedCount: {
      type: Number,
      default: 0,
    },
    lastVerifiedAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'revoked', 'expired'],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

verifiedClaimProofSchema.index({ userId: 1, claimType: 1, createdAt: -1 });

export const VerifiedClaimProof = mongoose.models.VerifiedClaimProof ||
  mongoose.model<IVerifiedClaimProof>('VerifiedClaimProof', verifiedClaimProofSchema);
