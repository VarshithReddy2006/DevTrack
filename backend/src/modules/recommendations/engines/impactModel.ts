// src/modules/recommendations/engines/impactModel.ts
import { Schema, type Types } from 'mongoose';
import { IntelligenceRecommendation } from '../../../db/models/intelligenceRecommendation.model.js';

export class RecommendationImpactEngine {
  
  static async evaluateImpact(userId: string | Schema.Types.ObjectId, resumeProfileId: string | Schema.Types.ObjectId, ids: Types.ObjectId[]): Promise<void> {
    await IntelligenceRecommendation.updateMany(
      { userId, resumeProfileId, _id: { $in: ids }, state: 'active', confidence: { $lt: 50 } },
      { $set: { state: 'ignored' } },
    );
  }
}
