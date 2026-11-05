import { Schema, model, type Document } from 'mongoose';
import { RecommendationItem } from '../../modules/resume/ai/recommendation.schema.js';

export interface IRecommendationDocument extends Document {
  sessionId: string;
  recommendations: RecommendationItem[];
  priorityScore: number;
  analysisVersion: string;
  generatedAt: Date;
}

const recommendationItemSchema = new Schema<RecommendationItem>({
  title: { type: String, required: true },
  explanation: { type: String, required: true },
  severity: { type: String, enum: ['high', 'medium', 'low'], required: true },
  priority: { type: Number, required: true },
  actionableSteps: [{ type: String }],
  estimatedImpact: { type: String, required: true },
  category: { 
    type: String, 
    enum: ['Resume Improvements', 'Skill Gaps', 'Career Alignment', 'Interview Readiness'], 
    required: true 
  }
}, { _id: false });

const recommendationSchema = new Schema<IRecommendationDocument>(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },
    recommendations: {
      type: [recommendationItemSchema],
      default: []
    },
    priorityScore: {
      type: Number,
      required: true,
      min: 0,
      max: 100
    },
    analysisVersion: {
      type: String,
      default: 'v1.0'
    },
    generatedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true,
  }
);

export const Recommendation = model<IRecommendationDocument>('Recommendation', recommendationSchema);
