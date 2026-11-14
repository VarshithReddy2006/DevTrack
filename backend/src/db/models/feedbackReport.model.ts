// src/db/models/feedbackReport.model.ts
// MongoDB persistence model for developer and recruiter calibration feedback reports.

import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IFeedbackReport extends Document {
  reportId: string;
  userId: string;
  source: 'developer' | 'recruiter' | 'admin';
  category: 'onboarding' | 'recommendation' | 'ats' | 'semantic_mismatch' | 'credibility';
  mismatchDetails: {
    expectedValue: unknown;
    systemValue: unknown;
    reasoning: string;
  };
  context?: Record<string, unknown>;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

const feedbackReportSchema = new Schema<IFeedbackReport>(
  {
    reportId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    source: {
      type: String,
      required: true,
      enum: ['developer', 'recruiter', 'admin'],
      index: true,
    },
    category: {
      type: String,
      required: true,
      enum: ['onboarding', 'recommendation', 'ats', 'semantic_mismatch', 'credibility'],
      index: true,
    },
    mismatchDetails: {
      expectedValue: { type: Schema.Types.Mixed },
      systemValue: { type: Schema.Types.Mixed },
      reasoning: { type: String, required: true },
    },
    context: { type: Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
  }
);

feedbackReportSchema.index({ category: 1, timestamp: -1 });

export const FeedbackReportModel: Model<IFeedbackReport> =
  (mongoose.models.FeedbackReport as Model<IFeedbackReport>) ||
  mongoose.model<IFeedbackReport>('FeedbackReport', feedbackReportSchema);
