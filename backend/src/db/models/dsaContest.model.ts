// src/db/models/dsaContest.model.ts
import { Schema, model, Types, type Document } from 'mongoose';

export interface IDsaContestRatingSyncCheckpoint {
  lastUserSettingsId: Types.ObjectId | null;
  retryUserSettingsIds: Types.ObjectId[];
  consecutiveTrips: number;
  updatedAt: Date;
}

export interface IDsaContest extends Document {
  userId?: Schema.Types.ObjectId;
  platform: 'leetcode' | 'codeforces' | 'codechef' | 'atcoder' | 'other';
  contestName: string;
  rank: number | null;
  totalParticipants: number | null;
  problemsSolved: number;
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingChange: number | null;
  participatedAt: Date;
  kind: 'participated' | 'scheduled';
  externalId?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
  durationSeconds?: number | null;
  url?: string | null;
  phase?: string | null;
  stale?: boolean;
  alertEmitted?: boolean;
  fetchedAt?: Date | null;
  ratingSyncCheckpoint?: IDsaContestRatingSyncCheckpoint | null;
  createdAt: Date;
}

const dsaContestSchema = new Schema<IDsaContest>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },
    platform: {
      type: String,
      enum: ['leetcode', 'codeforces', 'codechef', 'atcoder', 'other'],
      required: true,
    },
    contestName: {
      type: String,
      required: true,
    },
    kind: {
      type: String,
      enum: ['participated', 'scheduled'],
      default: 'participated',
      required: true,
    },
    externalId: {
      type: String,
      default: null,
    },
    startTime: {
      type: Date,
      default: null,
    },
    endTime: {
      type: Date,
      default: null,
    },
    durationSeconds: {
      type: Number,
      default: null,
    },
    url: {
      type: String,
      default: null,
    },
    phase: {
      type: String,
      default: null,
    },
    stale: {
      type: Boolean,
      default: false,
    },
    alertEmitted: {
      type: Boolean,
      default: false,
    },
    fetchedAt: {
      type: Date,
      default: null,
    },
    ratingSyncCheckpoint: {
      type: new Schema(
        {
          lastUserSettingsId: { type: Schema.Types.ObjectId, default: null },
          retryUserSettingsIds: { type: [Schema.Types.ObjectId], default: [] },
          consecutiveTrips: { type: Number, default: 0 },
          updatedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    rank: {
      type: Number,
      default: null,
    },
    totalParticipants: {
      type: Number,
      default: null,
    },
    problemsSolved: {
      type: Number,
      default: 0,
    },
    ratingBefore: {
      type: Number,
      default: null,
    },
    ratingAfter: {
      type: Number,
      default: null,
    },
    ratingChange: {
      type: Number,
      default: null,
    },
    participatedAt: {
      type: Date,
      default: Date.now,
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
dsaContestSchema.index({ userId: 1, participatedAt: -1 });
dsaContestSchema.index({ userId: 1, platform: 1 });
dsaContestSchema.index({ platform: 1, startTime: 1, kind: 1 });
dsaContestSchema.index(
  { platform: 1, externalId: 1, kind: 1 },
  {
    unique: true,
    partialFilterExpression: {
      kind: 'scheduled',
      externalId: { $type: 'string' },
    },
  }
);
dsaContestSchema.index({ kind: 1, startTime: 1, alertEmitted: 1 });
dsaContestSchema.index({ kind: 1, platform: 1, endTime: 1 });

export const DsaContest = model<IDsaContest>('DsaContest', dsaContestSchema);
