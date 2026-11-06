// src/db/models/dsaProblem.model.ts
import { Schema, model, type Document } from 'mongoose';
import { DSA_PROBLEM_PLATFORMS, type DsaProblemPlatform } from '../../shared/dsa-platforms.js';

export type DsaPlatform = DsaProblemPlatform;

export interface IDsaProblem extends Document {
  userId: Schema.Types.ObjectId;
  externalId: string;
  title: string;
  platform: DsaPlatform;
  difficulty: 'easy' | 'medium' | 'hard';
  url: string;
  tags: string[];
  category: string;
  status: 'unsolved' | 'attempted' | 'solved' | 'revisit';
  notes: string | null;
  timeTaken: number | null;
  submissionCount: number;
  lastSubmittedAt: Date | null;
  solvedAt: Date | null;
  isFavorite: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const dsaProblemSchema = new Schema<IDsaProblem>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    externalId: {
      type: String,
      default: '',
    },
    title: {
      type: String,
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: DSA_PROBLEM_PLATFORMS,
      required: true,
      index: true,
    },
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      required: true,
      index: true,
    },
    url: {
      type: String,
      required: true,
    },
    tags: {
      type: [String],
      default: [],
      index: true,
    },
    category: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['unsolved', 'attempted', 'solved', 'revisit'],
      default: 'unsolved',
      index: true,
    },
    notes: {
      type: String,
      default: null,
    },
    timeTaken: {
      type: Number,
      default: null,
    },
    submissionCount: {
      type: Number,
      default: 0,
    },
    lastSubmittedAt: {
      type: Date,
      default: null,
      index: true,
    },
    solvedAt: {
      type: Date,
      default: null,
      index: true,
    },
    isFavorite: {
      type: Boolean,
      default: false,
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
dsaProblemSchema.index({ userId: 1, status: 1, difficulty: 1, platform: 1, category: 1 });
dsaProblemSchema.index({ userId: 1, title: 'text', tags: 'text' });
dsaProblemSchema.index({ userId: 1, lastSubmittedAt: -1 });
dsaProblemSchema.index({ userId: 1, isFavorite: 1 });
// Unique index for deduplication
dsaProblemSchema.index({ userId: 1, platform: 1, externalId: 1 }, { unique: true });

export const DsaProblem = model<IDsaProblem>('DsaProblem', dsaProblemSchema);
