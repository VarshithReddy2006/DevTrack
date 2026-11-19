// src/db/models/jobTarget.model.ts — a job description a user wants to be matched against.
// The URL is only stored here; fetching happens later in the isolated worker-ai process.
import { Schema, model, type Document, type Types } from 'mongoose';
import { cascadeEmbeddingDeletes } from './embeddingCascade.js';

export type JobTargetStatus = 'submitted' | 'fetching' | 'ready' | 'failed' | 'completed';

export interface IJobTarget extends Document {
  userId: Types.ObjectId;
  /** Pasted description text, or null when the user supplied a URL. */
  text: string | null;
  /** Public job posting URL, or null when the user pasted text. */
  url: string | null;
  title: string | null;
  status: JobTargetStatus;
  failureReason: string | null;
  matchScore?: number;
  missingSkills: string[];
  scoredAt?: Date;
  /** Source identity fences replays and out-of-order scores, independent of inbox retention. */
  scoreEventId?: string;
  scoreNotification?: { leaseToken?: string; leaseUntil?: Date; notifiedAt?: Date };
  createdAt: Date;
  updatedAt: Date;
}

const jobTargetSchema = new Schema<IJobTarget>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: null },
    url: { type: String, default: null },
    title: { type: String, default: null },
    status: { type: String, enum: ['submitted', 'fetching', 'ready', 'failed', 'completed'], default: 'submitted', required: true },
    failureReason: { type: String, default: null },
    matchScore: { type: Number, min: 0, max: 100 },
    missingSkills: { type: [String], default: [] },
    scoredAt: { type: Date },
    scoreEventId: { type: String },
    scoreNotification: {
      leaseToken: { type: String },
      leaseUntil: { type: Date },
      notifiedAt: { type: Date },
    },
  },
  { timestamps: true },
);

jobTargetSchema.index({ userId: 1, createdAt: -1 });

// Deleting a target removes its embeddings, keyed on owner and target id.
cascadeEmbeddingDeletes(jobTargetSchema, ({ userId, _id }) => ({
  userId: userId as Types.ObjectId | string | null,
  sessionId: _id ? String(_id) : null,
}));

export const JobTarget = model<IJobTarget>('JobTarget', jobTargetSchema);
