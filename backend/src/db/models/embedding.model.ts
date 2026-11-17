// src/db/models/embedding.model.ts
import { Schema, model, type Document, type Types } from 'mongoose';
import { EMBEDDING_USER_HASH_INDEX } from './embeddingIndexes.js';

// Legacy types are still written by the resume pipeline and exist on stored rows, so they stay valid.
export const LEGACY_EMBEDDING_CONTENT_TYPES = ['resume', 'project', 'skill', 'other'] as const;
export const EMBEDDING_CONTENT_TYPES = [
  ...LEGACY_EMBEDDING_CONTENT_TYPES,
  'resume_bullet',
  'project_summary',
  'job_requirement',
  'interview_answer',
] as const;
export type EmbeddingContentType = (typeof EMBEDDING_CONTENT_TYPES)[number];

// Only these can live in the shared (global) dataset. Everything else is user content.
export const SHARED_EMBEDDING_CONTENT_TYPES: readonly EmbeddingContentType[] = ['skill', 'other'];
export const isSharedEmbeddingContentType = (type: EmbeddingContentType): boolean =>
  SHARED_EMBEDDING_CONTENT_TYPES.includes(type);

export interface IEmbedding extends Document {
  sessionId: string;
  chunkIndex: number;
  scope: 'user' | 'global';
  userId?: Types.ObjectId | null;
  
  // Vector data
  vector: number[];
  dimensions: number;
  
  // Provider metadata
  provider: 'openai' | 'gemini';
  providerModel: string;
  
  // Content metadata
  content: string;
  contentHash: string; // SHA-256 of the owner, chunk identity, and content
  contentType: EmbeddingContentType;
  contentId?: string;
  
  // Embedding version
  embeddingVersion: string;
  
  // Generation metadata
  generatedAt: Date;
  generationDuration?: number;
  
  // Usage metadata
  lastAccessedAt?: Date;
  accessCount: number;
  
  createdAt: Date;
  updatedAt: Date;
}

const embeddingSchema = new Schema<IEmbedding>(
  {
    sessionId: {
      type: String,
      required: true,
    },
    chunkIndex: {
      type: Number,
      required: true,
    },
    scope: { type: String, enum: ['user', 'global'], required: true },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: function (this: IEmbedding) { return this.scope === 'user'; },
      validate: {
        validator: function (this: IEmbedding, owner: Types.ObjectId | null) {
          return this.scope !== 'global' || owner == null;
        },
        message: 'Global embeddings cannot have a user owner',
      },
    },
    
    vector: {
      type: [Number],
      required: true,
    },
    
    dimensions: {
      type: Number,
      required: true,
    },
    
    provider: {
      type: String,
      required: true,
      enum: ['openai', 'gemini'],
    },
    
    providerModel: {
      type: String,
      required: true,
    },
    
    content: {
      type: String,
      required: true,
    },
    
    contentHash: {
      type: String,
      required: true,
    },
    
    contentType: {
      type: String,
      required: true,
      enum: EMBEDDING_CONTENT_TYPES,
      validate: {
        validator: function (this: IEmbedding, type: IEmbedding['contentType']) {
          return this.scope !== 'global' || isSharedEmbeddingContentType(type);
        },
        message: 'Private embeddings require a user owner',
      },
    },
    
    contentId: {
      type: String,
    },
    
    embeddingVersion: {
      type: String,
      required: true,
      default: '1.0.0',
    },
    
    generatedAt: {
      type: Date,
      required: true,
    },
    
    generationDuration: {
      type: Number,
    },
    
    lastAccessedAt: {
      type: Date,
    },
    
    accessCount: {
      type: Number,
      default: 0,
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
// Same text from two users must not collide, so uniqueness is per owner (global rows have userId null).
embeddingSchema.index(EMBEDDING_USER_HASH_INDEX.key, EMBEDDING_USER_HASH_INDEX.options);
embeddingSchema.index({ scope: 1, userId: 1, sessionId: 1, chunkIndex: 1, updatedAt: -1 });
embeddingSchema.index({ scope: 1, userId: 1, contentType: 1, createdAt: -1 });
embeddingSchema.index({ sessionId: 1 });
embeddingSchema.index({ sessionId: 1, chunkIndex: 1 });
embeddingSchema.index({ contentType: 1 });
embeddingSchema.index({ generatedAt: -1 });
embeddingSchema.index({ embeddingVersion: 1 });

export const Embedding = model<IEmbedding>('Embedding', embeddingSchema);
