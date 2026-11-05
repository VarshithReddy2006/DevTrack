import { Schema, model, type Document } from 'mongoose';
import { CredibilitySignal } from '../../modules/resume/credibility/credibility.schema.js';

export interface IResumeCredibility extends Document {
  sessionId: string;
  overallCredibility: number;
  dsaCredibility: number;
  projectCredibility: number;
  consistencyScore: number;
  verifiedClaims: string[];
  suspiciousClaims: string[];
  signals: CredibilitySignal[];
  summary: string;
  verifiedAt: Date;
}

const credibilitySignalMongooseSchema = new Schema<CredibilitySignal>({
  type: { type: String, enum: ['dsa', 'project', 'consistency', 'suspicious'], required: true },
  title: { type: String, required: true },
  description: { type: String, required: true },
  evidence: { type: String, required: true },
  impact: { type: Number, required: true },
}, { _id: false });

const resumeCredibilitySchema = new Schema<IResumeCredibility>({
  sessionId: {
    type: String,
    required: true,
    unique: true,
  },
  overallCredibility: { type: Number, required: true, default: 0 },
  dsaCredibility: { type: Number, required: true, default: 0 },
  projectCredibility: { type: Number, required: true, default: 0 },
  consistencyScore: { type: Number, required: true, default: 0 },
  verifiedClaims: { type: [String], default: [] },
  suspiciousClaims: { type: [String], default: [] },
  signals: { type: [credibilitySignalMongooseSchema], default: [] },
  summary: { type: String, required: true },
  verifiedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

export const ResumeCredibility = model<IResumeCredibility>('ResumeCredibility', resumeCredibilitySchema);
