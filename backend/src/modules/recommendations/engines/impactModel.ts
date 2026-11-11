// src/modules/recommendations/engines/impactModel.ts
import { Schema } from 'mongoose';
import { IntelligenceRecommendation } from '../../../db/models/intelligenceRecommendation.model.js';

export class RecommendationImpactEngine {
  
  static async evaluateImpact(userId: string | Schema.Types.ObjectId, resumeProfileId: string | Schema.Types.ObjectId): Promise<void> {
    const activeRecs = await IntelligenceRecommendation.find({ userId, resumeProfileId, state: 'active' });
    
    let totalAtsImprovement = 0;
    let totalCredibilityImprovement = 0;

    for (const rec of activeRecs) {
      // Base confidence check
      if (rec.confidence < 50) {
        rec.state = 'ignored'; // Cull low confidence recommendations
        await rec.save();
        continue;
      }

      // Contextual impact modifiers
      if (rec.category === 'ats') {
        totalAtsImprovement += rec.impact.scoreImprovement || 0;
      }
      
      if (rec.category === 'credibility' || rec.category === 'infrastructure') {
        totalCredibilityImprovement += rec.impact.scoreImprovement || 0;
      }

      if (rec.category === 'semantic') {
        // Boost semantic impact if confidence is very high (meaning the gap is severe)
        if (rec.confidence > 85) {
          rec.impact.scoreImprovement = Math.round((rec.impact.scoreImprovement || 0) * 1.5);
          await rec.save();
        }
      }

      // If a recommendation has many dependencies, its impact is "delayed" 
      // but its priority is actually lower than its dependencies.
      // We could add a 'priority' field, but for now we just log it.
    }

    // Optional: We could save these aggregates to the ResumeProfile or a RealismReport model.
  }
}
