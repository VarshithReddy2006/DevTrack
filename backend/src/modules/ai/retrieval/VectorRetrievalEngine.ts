import { embeddingScopeFilter, type EmbeddingScope } from '../embedding/embeddingScope.js';
import type { EmbeddingContentType } from '../../../db/models/embedding.model.js';
import { logger } from '../../../shared/logger.js';
import { SemanticSimilarityService } from './SemanticSimilarityService.js';
import { DEFAULT_VECTOR_INDEX_NAME, EmbeddingPersistenceLayer } from '../embedding/EmbeddingPersistenceLayer.js';

export interface VectorRetrievalOptions {
  indexName?: string;
  /** How long a capability probe result is reused. A failed native query clears it early. */
  capabilityTtlMs?: number;
}

export interface RetrieveTopKOptions {
  weightThreshold?: number;
  conceptFilter?: string[];
  contentTypes?: readonly EmbeddingContentType[];
}

// Over-fetch from the index: several chunks of one resume can hit and are folded into one result.
const NATIVE_OVERFETCH = 4;

export class VectorRetrievalEngine {
  private similarityService: SemanticSimilarityService;
  private persistence: EmbeddingPersistenceLayer;
  private readonly indexName: string;
  private readonly capabilityTtlMs: number;
  private capability?: { native: boolean; checkedAt: number };

  constructor(persistence: EmbeddingPersistenceLayer, options: VectorRetrievalOptions = {}) {
    this.similarityService = new SemanticSimilarityService();
    this.persistence = persistence;
    this.indexName = options.indexName ?? DEFAULT_VECTOR_INDEX_NAME;
    this.capabilityTtlMs = options.capabilityTtlMs ?? 5 * 60_000;
  }

  async retrieveTopK(
    scope: EmbeddingScope,
    queryVector: number[],
    k: number = 5,
    options?: RetrieveTopKOptions,
  ): Promise<{ id: string, score: number, vector?: number[] }[]> {
    logger.info(`[VectorRetrieval] Retrieving top ${k} matches`);

    embeddingScopeFilter(scope); // reject a missing owner before either query path runs
    const nativeHits = await this.tryNativeSearch(scope, queryVector, k, options);
    let ranked: { id: string, score: number }[];
    let vectors: Map<string, number[]>;

    if (nativeHits) {
      // Rescore with the same cosine math as the fallback so scores and weightThreshold mean
      // the same thing on both paths ($vectorSearch scores are normalised differently).
      vectors = new Map();
      for (const { id, vector } of nativeHits) if (!vectors.has(id)) vectors.set(id, vector);
      ranked = this.similarityService.rankCandidates(queryVector, nativeHits);
      const seen = new Set<string>();
      ranked = ranked.filter(({ id }) => !seen.has(id) && seen.add(id));
    } else {
      vectors = await this.persistence.getAllEmbeddings(scope, queryVector.length, options?.contentTypes);
      const candidates = Array.from(vectors.entries()).map(([id, vector]) => ({ id, vector }));
      ranked = this.similarityService.rankCandidates(queryVector, candidates);
    }

    if (options?.weightThreshold) {
      ranked = ranked.filter(c => c.score >= options.weightThreshold!);
    }

    return ranked.slice(0, k).map(r => ({ ...r, vector: vectors.get(r.id) }));
  }

  private async tryNativeSearch(
    scope: EmbeddingScope,
    queryVector: number[],
    k: number,
    options?: RetrieveTopKOptions,
  ) {
    if (!(await this.supportsNativeSearch())) return null;
    try {
      return await this.persistence.nativeVectorSearch(scope, queryVector, {
        indexName: this.indexName,
        limit: Math.max(1, k) * NATIVE_OVERFETCH,
        contentTypes: options?.contentTypes,
      });
    } catch (error) {
      // Index dropped or still building: re-probe next time and answer from the fallback.
      this.capability = undefined;
      logger.warn('[VectorRetrieval] $vectorSearch failed, using in-process cosine similarity', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async supportsNativeSearch(): Promise<boolean> {
    const now = Date.now();
    if (this.capability && now - this.capability.checkedAt < this.capabilityTtlMs) return this.capability.native;
    const native = await this.persistence.supportsNativeVectorSearch(this.indexName);
    this.capability = { native, checkedAt: now };
    if (!native) logger.info('[VectorRetrieval] No Atlas vector index available, using in-process cosine similarity');
    return native;
  }
}
