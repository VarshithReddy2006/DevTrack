import { EmbeddingProviderAdapter, type EmbeddingResponse } from './EmbeddingProviderAdapter.js';
import { EmbeddingPersistenceLayer } from './EmbeddingPersistenceLayer.js';
import { embeddingScopeFilter, type EmbeddingScope } from './embeddingScope.js';

export class RealEmbeddingPipeline {
  private readonly provider = new EmbeddingProviderAdapter();

  constructor(private readonly persistence = new EmbeddingPersistenceLayer()) {}

  async embedText(text: string, scope?: EmbeddingScope): Promise<EmbeddingResponse> {
    return this.provider.generateEmbedding(text, scope);
  }

  async processAndStore(id: string, text: string, scope: Extract<EmbeddingScope, { scope: 'user' }>): Promise<EmbeddingResponse> {
    const owner = embeddingScopeFilter(scope);
    if (owner.scope !== 'user') throw new Error('Resume embeddings require a user owner');

    const embedding = await this.embedText(text, scope);
    await this.persistence.saveEmbedding(scope, id, 0, embedding.vector, embedding.provider, embedding.model, text, 'resume');
    return embedding;
  }

  async getEmbeddingForId(scope: EmbeddingScope, id: string): Promise<number[] | null> {
    return this.persistence.getEmbedding(scope, id);
  }

  async getStore(): Promise<EmbeddingPersistenceLayer> {
    return this.persistence;
  }
}
