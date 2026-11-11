import { createHash } from 'node:crypto';
import { Embedding, type IEmbedding } from '../../../db/models/embedding.model.js';
import { EMBEDDING_VERSION, embeddingScopeFilter, type EmbeddingScope } from './embeddingScope.js';

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
    if (owner.scope === 'global' && (contentType === 'resume' || contentType === 'project')) {
      throw new Error('Resume and project embeddings require a user owner');
    }
    if (!vector.length || !vector.every(Number.isFinite)) throw new Error('Invalid embedding vector');

    // Keep the existing unique index while giving each owner and chunk its own hash.
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

  async getAllEmbeddings(scope: EmbeddingScope, dimensions: number): Promise<Map<string, number[]>> {
    const embeddings = await Embedding.find({ ...embeddingScopeFilter(scope), dimensions })
      .sort({ chunkIndex: 1, updatedAt: -1 }).select('sessionId vector').lean();
    const vectors = new Map<string, number[]>();
    for (const { sessionId, vector } of embeddings) {
      if (!vectors.has(sessionId)) vectors.set(sessionId, vector);
    }
    return vectors;
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
