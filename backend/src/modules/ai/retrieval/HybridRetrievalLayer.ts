import type { EmbeddingScope } from '../embedding/embeddingScope.js';
import { logger } from '../../../shared/logger.js';
import { VectorRetrievalEngine } from './VectorRetrievalEngine.js';

export class HybridRetrievalLayer {
  private vectorEngine: VectorRetrievalEngine;

  constructor(vectorEngine: VectorRetrievalEngine) {
    this.vectorEngine = vectorEngine;
  }

  async retrieve(scope: EmbeddingScope, queryVector: number[], deterministicMatches: string[], alpha: number = 0.5): Promise<{ id: string, score: number }[]> {
    logger.info('[HybridRetrieval] Merging semantic and deterministic results');
    
    const semanticResults = await this.vectorEngine.retrieveTopK(scope, queryVector, 20);
    const semanticScoreMap = new Map(semanticResults.map(r => [r.id, r.score]));
    
    const combinedScores = new Map<string, number>();
    
    // Merge deterministic
    for (const id of deterministicMatches) {
      combinedScores.set(id, (combinedScores.get(id) || 0) + (1 * (1 - alpha))); // deterministic score is 1.0
    }
    
    // Merge semantic
    for (const [id, score] of semanticScoreMap.entries()) {
      combinedScores.set(id, (combinedScores.get(id) || 0) + (score * alpha));
    }
    
    return Array.from(combinedScores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score);
  }
}
