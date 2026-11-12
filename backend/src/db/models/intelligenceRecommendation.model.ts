// src/db/models/intelligenceRecommendation.model.ts
import { createHash } from 'node:crypto';
import { Schema, model, type Document, type Types } from 'mongoose';

export type RecommendationCategory = 'ats' | 'semantic' | 'credibility' | 'infrastructure' | 'role_alignment';
const recommendationStates = ['active', 'accepted', 'completed', 'ignored', 'decayed', 'retired'] as const;
export type RecommendationState = typeof recommendationStates[number];

interface RecommendationEvent {
  eventType: string;
  timestamp: Date;
}

export interface IIntelligenceRecommendation extends Document {
  userId: Schema.Types.ObjectId;
  resumeProfileId: Schema.Types.ObjectId;
  
  category: RecommendationCategory;
  title: string;
  content: string; // The specific, engineering-focused recommendation text
  
  confidence: number; // 0-100
  impact: {
    scoreImprovement: number;
    type: 'ats' | 'semantic' | 'credibility';
  };
  
  // Array of string references to issues in ATSAnalysis or IDs of ResumeEvidenceClaim
  evidenceReferences: string[];
  
  // IDs of other recommendations that must be completed first
  dependencies: Schema.Types.ObjectId[];
  
  state: RecommendationState;
  generationKey?: string;
  acceptedAt?: Date;
  completedAt?: Date;
  ignoredAt?: Date;
  decayedAt?: Date;
  retiredAt?: Date;
  lastViewedAt?: Date;
  viewCount: number;
  currentDecay: number;
  effectivenessScore?: number;
  lifecycleEvents: RecommendationEvent[];
  
  metadata: Record<string, unknown>; // E.g., for semantic concepts missed

  createdAt: Date;
  updatedAt: Date;
}

const intelligenceRecommendationSchema = new Schema<IIntelligenceRecommendation>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    resumeProfileId: {
      type: Schema.Types.ObjectId,
      ref: 'ResumeProfile',
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ['ats', 'semantic', 'credibility', 'infrastructure', 'role_alignment'],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    impact: {
      scoreImprovement: { type: Number, default: 0 },
      type: { type: String, enum: ['ats', 'semantic', 'credibility'], default: 'ats' },
    },
    evidenceReferences: {
      type: [String],
      default: [],
    },
    dependencies: {
      type: [Schema.Types.ObjectId],
      ref: 'IntelligenceRecommendation',
      default: [],
    },
    state: {
      type: String,
      enum: recommendationStates,
      default: 'active',
      index: true,
    },
    generationKey: String,
    acceptedAt: Date,
    completedAt: Date,
    ignoredAt: Date,
    decayedAt: Date,
    retiredAt: Date,
    lastViewedAt: Date,
    viewCount: { type: Number, default: 0 },
    currentDecay: { type: Number, default: 0 },
    effectivenessScore: { type: Number, min: 0, max: 100 },
    lifecycleEvents: {
      type: [new Schema<RecommendationEvent>({
        eventType: { type: String, required: true },
        timestamp: { type: Date, required: true },
      }, { _id: false })],
      default: [],
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
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

intelligenceRecommendationSchema.pre('validate', function () {
  if (this.isNew && this.lifecycleEvents.length === 0) {
    this.lifecycleEvents.push({ eventType: 'generated', timestamp: this.createdAt ?? new Date() });
  }
});

// Indexes for fast lookup by resume
intelligenceRecommendationSchema.index({ resumeProfileId: 1, state: 1 });
intelligenceRecommendationSchema.index({ userId: 1, category: 1 });

intelligenceRecommendationSchema.index({ userId: 1, resumeProfileId: 1, generationKey: 1 }, {
  unique: true,
  partialFilterExpression: { generationKey: { $type: 'string' } },
});

export const IntelligenceRecommendation = model<IIntelligenceRecommendation>('IntelligenceRecommendation', intelligenceRecommendationSchema);

type RecommendationDraft = Pick<IIntelligenceRecommendation,
  'category' | 'title' | 'content' | 'confidence' | 'impact' | 'evidenceReferences'
> & { userId: string | Schema.Types.ObjectId; resumeProfileId: string | Schema.Types.ObjectId };

// A repeated analysis of the same finding keeps its original lifecycle.
export async function saveGeneratedRecommendation(draft: RecommendationDraft): Promise<Types.ObjectId> {
  const { userId, resumeProfileId, category, title, content, evidenceReferences } = draft;
  const evidence = evidenceReferences.filter(reference => !reference.startsWith('similarity_score_'));
  const generationKey = createHash('sha256')
    .update(JSON.stringify([category, title, content, evidence]))
    .digest('hex');
  const scope = { userId, resumeProfileId };
  const key = { ...scope, generationKey };
  const legacy = {
    ...scope, category, title, content, generationKey: { $exists: false },
    ...(category === 'semantic' ? {} : { evidenceReferences }),
  };
  const now = new Date();
  const fields = { confidence: draft.confidence, impact: draft.impact, evidenceReferences };
  try {
    const existing = await IntelligenceRecommendation.findOneAndUpdate(
      { ...key, state: 'active' }, { $set: fields }, { new: true, projection: '_id' },
    );
    if (existing) return existing._id;
    const terminal = await IntelligenceRecommendation.exists(key);
    if (terminal) return terminal._id;

    const adopted = await IntelligenceRecommendation.findOneAndUpdate(
      legacy, { $set: { generationKey } }, { new: true, projection: '_id' },
    );
    if (adopted) return adopted._id;

    const inserted = await IntelligenceRecommendation.findOneAndUpdate(key, {
      $setOnInsert: {
        ...draft, generationKey, createdAt: now, updatedAt: now,
        lifecycleEvents: [{ eventType: 'generated', timestamp: now }],
      },
    }, { upsert: true, new: true, projection: '_id', runValidators: true, timestamps: false });
    return inserted!._id;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 11000) {
      const winner = await IntelligenceRecommendation.exists(key);
      if (winner) return winner._id;
    }
    throw error;
  }
}
