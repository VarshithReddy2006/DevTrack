// src/db/models/dsaSubmission.model.ts
import { Schema, model, type Document } from 'mongoose';

export type DsaPlatform = 'leetcode' | 'codeforces';

export interface IDsaSubmission extends Document {
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
}

const dsaSubmissionSchema = new Schema<IDsaSubmission>(
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
  },
  {
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

// Indexes
dsaSubmissionSchema.index({ userId: 1, submittedAt: -1 });
dsaSubmissionSchema.index({ userId: 1, problemId: 1, submittedAt: -1 });
dsaSubmissionSchema.index({ userId: 1, status: 1 });
// Unique index for deduplication: userId + platform + externalId
dsaSubmissionSchema.index({ userId: 1, platform: 1, externalId: 1 }, { unique: true });

export const DsaSubmission = model<IDsaSubmission>('DsaSubmission', dsaSubmissionSchema);
