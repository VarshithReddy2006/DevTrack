// src/db/models/readinessInput.model.ts: Consumer-maintained inputs for career readiness.
// One document per user. The domain-readiness consumers keep per-day buckets for the
// rolling 7-day window (keys are UTC YYYY-MM-DD) plus the parsed job target context.
import { Schema, model, type Document, type Types } from 'mongoose';

export interface IFocusDayBucket {
  sessions: number;
  qualifiedSessions: number;
  qualifiedMinutes: number;
}

export interface IRevisionDayBucket {
  reviews: number;
  lapses: number;
}

export interface IJobTargetContext {
  jobTargetId: string;
  targetRole?: string;
  company?: string;
  requiredSkills: string[];
  analysisMode?: 'ai' | 'taxonomy_only';
  parsedAt: Date;
}

export interface IJobTargetScoreContext {
  jobTargetId: string;
  matchScore: number;
  missingSkills: string[];
  highPrioritySkills: string[];
  scoredAt: Date;
  eventId: string;
}

export interface IReadinessInput extends Document {
  userId: Types.ObjectId;
  focusDays: Map<string, IFocusDayBucket>;
  revisionDays: Map<string, IRevisionDayBucket>;
  jobTargets: {
    /** Distinct parsed job targets; the active count is its size. */
    targetIds: string[];
    latest?: IJobTargetContext;
    latestScore?: IJobTargetScoreContext;
  };
  createdAt: Date;
  updatedAt: Date;
}

const focusDaySchema = new Schema<IFocusDayBucket>(
  {
    sessions: { type: Number, default: 0 },
    qualifiedSessions: { type: Number, default: 0 },
    qualifiedMinutes: { type: Number, default: 0 },
  },
  { _id: false },
);

const revisionDaySchema = new Schema<IRevisionDayBucket>(
  {
    reviews: { type: Number, default: 0 },
    lapses: { type: Number, default: 0 },
  },
  { _id: false },
);

const jobTargetContextSchema = new Schema<IJobTargetContext>(
  {
    jobTargetId: { type: String, required: true },
    targetRole: { type: String },
    company: { type: String },
    requiredSkills: { type: [String], default: [] },
    analysisMode: { type: String, enum: ['ai', 'taxonomy_only'] },
    parsedAt: { type: Date, required: true },
  },
  { _id: false },
);

const readinessInputSchema = new Schema<IReadinessInput>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    focusDays: { type: Map, of: focusDaySchema, default: () => new Map() },
    revisionDays: { type: Map, of: revisionDaySchema, default: () => new Map() },
    jobTargets: {
      targetIds: { type: [String], default: [] },
      latest: { type: jobTargetContextSchema },
      latestScore: {
        type: new Schema<IJobTargetScoreContext>({
          jobTargetId: { type: String, required: true },
          matchScore: { type: Number, required: true, min: 0, max: 100 },
          missingSkills: { type: [String], default: [] },
          highPrioritySkills: { type: [String], default: [] },
          scoredAt: { type: Date, required: true },
          eventId: { type: String, required: true },
        }, { _id: false }),
      },
    },
  },
  { timestamps: true },
);

export const ReadinessInput = model<IReadinessInput>('ReadinessInput', readinessInputSchema);
