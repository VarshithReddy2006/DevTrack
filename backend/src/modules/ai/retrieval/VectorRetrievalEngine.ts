import type { EmbeddingScope } from '../embedding/embeddingScope.js';
import { logger } from '../../../shared/logger.js';
import { SemanticSimilarityService } from './SemanticSimilarityService.js';
import { EmbeddingPersistenceLayer } from '../embedding/EmbeddingPersistenceLayer.js';

export class VectorRetrievalEngine {
  private similarityService: SemanticSimilarityService;
  private persistence: EmbeddingPersistenceLayer;

  constructor(persistence: EmbeddingPersistenceLayer) {
    this.similarityService = new SemanticSimilarityService();
    this.persistence = persistence;
  }

  async retrieveTopK(
    scope: EmbeddingScope,
    queryVector: number[], 
    k: number = 5, 
    options?: { weightThreshold?: number, conceptFilter?: string[] }
  ): Promise<{ id: string, score: number, vector?: number[] }[]> {
    logger.info(`[VectorRetrieval] Retrieving top ${k} matches`);
    
    const store = await this.persistence.getAllEmbeddings(scope, queryVector.length);
    const candidates = Array.from(store.entries()).map(([id, vector]) => ({ id, vector }));
    
    // In a real DB, we would filter by conceptFilter here
    // For now we just rank them
    let ranked = this.similarityService.rankCandidates(queryVector, candidates);
    
    if (options?.weightThreshold) {
      ranked = ranked.filter(c => c.score >= options.weightThreshold!);
    }
    
    return ranked.slice(0, k).map(r => ({ ...r, vector: store.get(r.id) }));
  }
}
