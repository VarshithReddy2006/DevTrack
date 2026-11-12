// src/modules/recommendations/engines/dependencyGraph.ts
import { Schema, type Types } from 'mongoose';
import { IntelligenceRecommendation } from '../../../db/models/intelligenceRecommendation.model.js';

export class RecommendationDependencyGraph {
  
  static async resolveDependencies(userId: string | Schema.Types.ObjectId, resumeProfileId: string | Schema.Types.ObjectId, ids: Types.ObjectId[]): Promise<void> {
    const scope = { userId, resumeProfileId, state: 'active', _id: { $in: ids } };
    const rows = await IntelligenceRecommendation.find(scope).select('_id category').lean();
    const atsIds = rows.filter(rec => rec.category === 'ats').map(rec => rec._id);
    const credibilityIds = rows.filter(rec => rec.category === 'credibility').map(rec => rec._id);

    await IntelligenceRecommendation.updateMany(
      { ...scope, category: 'credibility' },
      { $set: { dependencies: atsIds } },
    );
    await IntelligenceRecommendation.updateMany(
      { ...scope, category: { $in: ['infrastructure', 'semantic'] } },
      { $set: { dependencies: [...atsIds, ...credibilityIds] } },
    );
  }
}
