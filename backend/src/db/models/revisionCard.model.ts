// src/db/models/revisionCard.model.ts — DSA Spaced Repetition Revision Card
import { Schema, model, type Document, type Types } from 'mongoose';

export type ProblemDifficulty = 'easy' | 'medium' | 'hard';

export interface IRevisionCard extends Document {
  userId: Types.ObjectId;
  problemKey: string; // e.g. "leetcode:two-sum" or "codeforces:123A"
  title: string;
  difficulty: ProblemDifficulty;
  tags: string[];
  tagWeight: number;
  reviewSeq: number; // monotonic sequence for optimistic concurrency
  repetitions: number;
  easeFactor: number;
  intervalDays: number;
  dueAt: Date;
  lastReviewedAt?: Date | null;
  snoozedUntil?: Date | null;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const revisionCardSchema = new Schema<IRevisionCard>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    problemKey: {
      type: String,
      required: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      default: 'medium',
    },
    tags: {
      type: [String],
      default: [],
    },
    reviewSeq: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    tagWeight: { type: Number, default: 1, min: 0.1, max: 10 },
    repetitions: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    easeFactor: {
      type: Number,
      required: true,
      default: 2.5,
      min: 1.3,
    },
    intervalDays: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    dueAt: {
      type: Date,
      required: true,
      index: true,
    },
    lastReviewedAt: {
      type: Date,
      default: null,
    },
    snoozedUntil: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index ensuring one card per problem per user
revisionCardSchema.index({ userId: 1, problemKey: 1 }, { unique: true });

// Query indexes for due review queue retrieval
revisionCardSchema.index({ userId: 1, dueAt: 1 });
revisionCardSchema.index({ userId: 1, snoozedUntil: 1 });

export const RevisionCard = model<IRevisionCard>('RevisionCard', revisionCardSchema);
