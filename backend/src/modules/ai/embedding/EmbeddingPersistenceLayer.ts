import { createHash } from 'node:crypto';
import { Embedding, isSharedEmbeddingContentType, type EmbeddingContentType, type IEmbedding } from '../../../db/models/embedding.model.js';
import { EMBEDDING_VERSION, embeddingScopeFilter, type EmbeddingScope } from './embeddingScope.js';

export const DEFAULT_VECTOR_INDEX_NAME = 'embeddings_vector_idx';
const MAX_NUM_CANDIDATES = 10_000;

export interface VectorSearchOptions {
  indexName: string;
  limit: number;
  contentTypes?: readonly EmbeddingContentType[];
}

/**
 * Atlas `$vectorSearch` pipeline for one owner. The owner goes into the pre-filter (so other
 * users' vectors are never candidates) and is asserted again with a `$match` afterwards.
 * `userId: null` is not a valid vector search filter value, so the shared dataset filters on scope alone.
 */
export function buildVectorSearchPipeline(scope: EmbeddingScope, queryVector: number[], options: VectorSearchOptions) {
  const owner = embeddingScopeFilter(scope);
  const filter: Record<string, unknown> = owner.scope === 'global'
    ? { scope: 'global' }
    : { scope: 'user', userId: owner.userId };
  filter.dimensions = queryVector.length;
  if (options.contentTypes?.length) filter.contentType = { $in: [...options.contentTypes] };

  const limit = Math.max(1, Math.floor(options.limit));
  return [
    {
      $vectorSearch: {
        index: options.indexName,
        path: 'vector',
        queryVector,
        numCandidates: Math.min(Math.max(limit * 20, 100), MAX_NUM_CANDIDATES),
        limit,
        filter,
      },
    },
    { $match: { ...owner, dimensions: queryVector.length } },
    { $project: { _id: 0, sessionId: 1, chunkIndex: 1, vector: 1 } },
  ];
}

export class EmbeddingPersistenceLayer {
  async saveEmbedding(
    scope: EmbeddingScope,
    sessionId: string,
    chunkIndex: number,
    vector: number[],
    provider: IEmbedding['provider'],
    providerModel: string,
    content: string,
    contentType: IEmbedding['contentType'],
    contentId?: string,
  ): Promise<void> {
    const owner = embeddingScopeFilter(scope);
    if (owner.scope === 'global' && !isSharedEmbeddingContentType(contentType)) {
      throw new Error('Private embeddings require a user owner');
    }
    if (!vector.length || !vector.every(Number.isFinite)) throw new Error('Invalid embedding vector');

    // The hash covers owner, chunk identity and content; uq_embeddings_user_hash enforces it per owner.
    const contentHash = createHash('sha256').update(JSON.stringify([
      EMBEDDING_VERSION, owner.scope, owner.userId?.toHexString(), sessionId, chunkIndex, contentType, content,
    ])).digest('hex');
    const filter = { ...owner, contentHash };
    const update = {
      $set: {
        sessionId, chunkIndex, vector, dimensions: vector.length, provider, providerModel,
        content, contentType, contentId, embeddingVersion: EMBEDDING_VERSION, generatedAt: new Date(),
      },
      $setOnInsert: owner,
      $inc: { accessCount: 1 },
    };
    try {
      await Embedding.updateOne(filter, update, { upsert: true, runValidators: true });
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const result = await Embedding.updateOne(filter, update, { runValidators: true });
      if (!result.matchedCount) throw error;
    }
  }

  async getEmbedding(scope: EmbeddingScope, sessionId: string): Promise<number[] | null> {
    const embedding = await Embedding.findOneAndUpdate(
      { ...embeddingScopeFilter(scope), sessionId },
      { $set: { lastAccessedAt: new Date() }, $inc: { accessCount: 1 } },
      { sort: { chunkIndex: 1, updatedAt: -1 } },
    ).select('vector').lean();
    return embedding?.vector ?? null;
  }

  async getAllEmbeddings(
    scope: EmbeddingScope,
    dimensions: number,
    contentTypes?: readonly EmbeddingContentType[],
  ): Promise<Map<string, number[]>> {
    const typeFilter = contentTypes?.length ? { contentType: { $in: [...contentTypes] } } : {};
    const embeddings = await Embedding.find({ ...embeddingScopeFilter(scope), dimensions, ...typeFilter })
      .sort({ chunkIndex: 1, updatedAt: -1 }).select('sessionId vector').lean();
    const vectors = new Map<string, number[]>();
    for (const { sessionId, vector } of embeddings) {
      if (!vectors.has(sessionId)) vectors.set(sessionId, vector);
    }
    return vectors;
  }

  /** True when this deployment has a queryable Atlas vector search index with that name. */
  async supportsNativeVectorSearch(indexName: string): Promise<boolean> {
    try {
      const indexes = await Embedding.collection
        .aggregate<{ queryable?: boolean }>([{ $listSearchIndexes: { name: indexName } }])
        .toArray();
      return indexes.some(index => index.queryable === true);
    } catch {
      // Plain MongoDB rejects the stage; any failure here means "use the in-process path".
      return false;
    }
  }

  /** Approximate nearest chunks for one owner through `$vectorSearch`. Callers rescore the vectors. */
  async nativeVectorSearch(
    scope: EmbeddingScope,
    queryVector: number[],
    options: VectorSearchOptions,
  ): Promise<{ id: string; vector: number[] }[]> {
    const hits = await Embedding.collection
      .aggregate<{ sessionId: string; vector: number[] }>(buildVectorSearchPipeline(scope, queryVector, options))
      .toArray();
    return hits.map(({ sessionId, vector }) => ({ id: sessionId, vector }));
  }

  async deleteEmbedding(scope: EmbeddingScope, sessionId: string): Promise<void> {
    await Embedding.deleteMany({ ...embeddingScopeFilter(scope), sessionId });
  }

  async clear(scope: EmbeddingScope): Promise<void> {
    await Embedding.deleteMany(embeddingScopeFilter(scope));
  }

  async getEmbeddingMetadata(scope: EmbeddingScope, sessionId: string) {
    return Embedding.findOne({ ...embeddingScopeFilter(scope), sessionId })
      .sort({ chunkIndex: 1, updatedAt: -1 }).lean();
  }
}
