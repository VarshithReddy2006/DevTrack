// src/db/models/aiConversation.model.ts
import { Schema, model, Document, Types } from 'mongoose';

export interface IConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  tokensUsed?: number;
  confidence?: number;
}

export interface IAIConversation extends Document {
  userId: Types.ObjectId | string;
  threadId: string;
  contextType: 'copilot' | 'roadmap' | 'mentor' | 'general';
  title?: string;
  targetRole?: string;
  messages: IConversationTurn[];
  createdAt: Date;
  updatedAt: Date;
}

const conversationTurnSchema = new Schema<IConversationTurn>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    tokensUsed: { type: Number },
    confidence: { type: Number },
  },
  { _id: false }
);

const aiConversationSchema = new Schema<IAIConversation>(
  {
    userId: { type: Schema.Types.Mixed, ref: 'User', required: true, index: true },
    threadId: { type: String, required: true },
    contextType: {
      type: String,
      enum: ['copilot', 'roadmap', 'mentor', 'general'],
      default: 'copilot',
    },
    title: { type: String },
    targetRole: { type: String },
    messages: { type: [conversationTurnSchema], default: [] },
  },
  { timestamps: true }
);

aiConversationSchema.index({ userId: 1, threadId: 1 }, { unique: true });
aiConversationSchema.index({ userId: 1, contextType: 1, updatedAt: -1 });

export const AIConversation = model<IAIConversation>('AIConversation', aiConversationSchema);
