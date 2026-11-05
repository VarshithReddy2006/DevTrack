// src/db/models/embedding.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IEmbedding extends Document {
  sessionId: string;
  chunkIndex: number;
  userId?: Schema.Types.ObjectId;
  
  // Vector data
  vector: number[];
  dimensions: number;
  
  // Provider metadata
  provider: 'openai' | 'gemini';
  providerModel: string;
  
  // Content metadata
  content: string;
  contentHash: string; // SHA-256 hash of the content for deduplication
  contentType: 'resume' | 'project' | 'skill' | 'other';
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
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
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
      unique: true,
    },
    
    contentType: {
      type: String,
      required: true,
      enum: ['resume', 'project', 'skill', 'other'],
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
embeddingSchema.index({ sessionId: 1 });
embeddingSchema.index({ sessionId: 1, chunkIndex: 1 });
embeddingSchema.index({ userId: 1 });
embeddingSchema.index({ contentType: 1 });
embeddingSchema.index({ generatedAt: -1 });
embeddingSchema.index({ embeddingVersion: 1 });

export const Embedding = model<IEmbedding>('Embedding', embeddingSchema);
