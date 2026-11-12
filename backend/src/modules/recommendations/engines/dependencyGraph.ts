// src/modules/recommendations/engines/dependencyGraph.ts
import { Schema } from 'mongoose';
import { IntelligenceRecommendation } from '../../../db/models/intelligenceRecommendation.model.js';

export class RecommendationDependencyGraph {
  
  static async resolveDependencies(userId: string | Schema.Types.ObjectId, resumeProfileId: string | Schema.Types.ObjectId): Promise<void> {
    const activeRecs = await IntelligenceRecommendation.find({ userId, resumeProfileId, state: 'active' });
    
    // Categorize
    const atsRecs = activeRecs.filter(r => r.category === 'ats');
    const credibilityRecs = activeRecs.filter(r => r.category === 'credibility');
    const infraRecs = activeRecs.filter(r => r.category === 'infrastructure');
    const semanticRecs = activeRecs.filter(r => r.category === 'semantic');

    // Rule 1: ATS issues block everything else.
    // If the parser can't read the resume, semantic and infra gaps don't matter yet.
    if (atsRecs.length > 0) {
      const atsIds = atsRecs.map(r => r._id);
      
      const toUpdate = [...credibilityRecs, ...infraRecs, ...semanticRecs];
      for (const rec of toUpdate) {
        if (!rec.dependencies) rec.dependencies = [];
        // Add ATS dependencies to non-ATS recs
        for (const atsId of atsIds) {
          if (!rec.dependencies.includes(atsId as any)) {
            rec.dependencies.push(atsId as any);
          }
        }
        await rec.save();
      }
    }

    // Rule 2: Basic Credibility blocks Infrastructure / Semantic
    // You must fix your unsupported claims before adding complex architecture.
    if (credibilityRecs.length > 0) {
      const credIds = credibilityRecs.map(r => r._id);
      
      const toUpdate = [...infraRecs, ...semanticRecs];
      for (const rec of toUpdate) {
        if (!rec.dependencies) rec.dependencies = [];
        for (const credId of credIds) {
          if (!rec.dependencies.includes(credId as any)) {
            rec.dependencies.push(credId as any);
          }
        }
        await rec.save();
      }
    }
  }
}
