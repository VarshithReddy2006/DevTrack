// src/db/models/dsaSubmissionArchive.model.ts — Cold storage for aged DSA submissions.
// Mirrors the live DsaSubmission schema so archived records remain queryable through a
// unified abstraction. Kept in a separate collection so hot indexes stay compact.

import { Schema, model, type Document } from 'mongoose';

export type DsaPlatform = 'leetcode' | 'codeforces';

export interface IDsaSubmissionArchive extends Document {
  userId: Schema.Types.ObjectId;
  problemId: Schema.Types.ObjectId;
  platform: DsaPlatform;
  externalId: string;
  status: 'accepted' | 'wrong' | 'time_limit_exceeded' | 'runtime_error' | 'compilation_error';
  language: string;
  codeSnippet: string | null;
  submittedAt: Date;
  executionTime: number | null;
  memoryUsed: number | null;
  runtimePercentile: number | null;
  revisionEvaluationQueued: boolean;
  topicTags: string[];
  createdAt: Date;
  /** Timestamp when the record was moved out of the hot collection. */
  archivedAt: Date;
}

const dsaSubmissionArchiveSchema = new Schema<IDsaSubmissionArchive>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    problemId: {
      type: Schema.Types.ObjectId,
      ref: 'DsaProblem',
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['leetcode', 'codeforces'],
      required: true,
      index: true,
    },
    externalId: {
      type: String,
      required: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['accepted', 'wrong', 'time_limit_exceeded', 'runtime_error', 'compilation_error'],
      required: true,
    },
    language: {
      type: String,
      required: true,
    },
    codeSnippet: {
      type: String,
      default: null,
    },
    submittedAt: {
      type: Date,
      required: true,
      index: true,
    },
    executionTime: {
      type: Number,
      default: null,
    },
    memoryUsed: {
      type: Number,
      default: null,
    },
    runtimePercentile: { type: Number, default: null, min: 0, max: 100 },
    revisionEvaluationQueued: { type: Boolean, default: false },
    topicTags: {
      type: [String],
      default: [],
      index: true,
    },
    archivedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    collection: 'dsa_submissions_archive',
    timestamps: { createdAt: true, updatedAt: false },
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

// Indexes mirror the hot collection's most-used access patterns.
dsaSubmissionArchiveSchema.index({ userId: 1, createdAt: -1 });
dsaSubmissionArchiveSchema.index({ userId: 1, submittedAt: -1 });
dsaSubmissionArchiveSchema.index({ userId: 1, platform: 1, externalId: 1 }, { unique: true });

export const DsaSubmissionArchive = model<IDsaSubmissionArchive>('DsaSubmissionArchive', dsaSubmissionArchiveSchema);
