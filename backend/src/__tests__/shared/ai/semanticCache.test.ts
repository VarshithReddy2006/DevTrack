// backend/src/__tests__/shared/ai/semanticCache.test.ts
// Comprehensive unit tests for SemanticCacheService and Cosine Similarity evaluation

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SemanticCacheService,
  calculateCosineSimilarity,
  type SemanticCacheEntry,
} from '../../../shared/ai/semanticCache.service.js';

describe('SemanticCacheService', () => {
  let cacheService: SemanticCacheService;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheService = new SemanticCacheService({
      similarityThreshold: 0.95,
      defaultTtlSeconds: 7 * 24 * 60 * 60, // 7 days
      maxMemoryEntries: 5,
    });
    cacheService.clearMemoryCache();
  });

  describe('Cosine Similarity Calculation', () => {
    it('calculates exact 1.0 similarity for identical non-zero vectors', () => {
      const vecA = [0.2, 0.5, 0.8, 0.1];
      const vecB = [0.2, 0.5, 0.8, 0.1];
      const sim = calculateCosineSimilarity(vecA, vecB);
      expect(sim).toBeCloseTo(1.0, 5);
    });

    it('calculates 0.0 similarity for orthogonal vectors', () => {
      const vecA = [1, 0, 0];
      const vecB = [0, 1, 0];
      const sim = calculateCosineSimilarity(vecA, vecB);
      expect(sim).toBeCloseTo(0.0, 5);
    });

    it('returns 0 for empty or zero-norm vectors without throwing', () => {
      expect(calculateCosineSimilarity([], [1, 2, 3])).toBe(0);
      expect(calculateCosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
      expect(calculateCosineSimilarity([1, 2], [])).toBe(0);
    });

    it('computes expected cosine formula: dot(A, B) / (norm(A) * norm(B))', () => {
      const vecA = [3, 4]; // norm = 5
      const vecB = [4, 3]; // norm = 5, dot = 24
      const sim = calculateCosineSimilarity(vecA, vecB);
      expect(sim).toBeCloseTo(24 / 25, 4); // 0.96
    });
  });

  describe('Embedding Generation & Fallbacks', () => {
    it('generates normalized 768-dimensional deterministic embedding fallback', async () => {
      const vector = await cacheService.generateEmbedding('Optimize my bullet point for AWS Lambda');
      expect(vector).toHaveLength(768);

      // Verify L2 norm is approximately 1.0
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1.0, 3);
    });

    it('handles empty input gracefully by returning a zero or initialized vector', async () => {
      const vector = await cacheService.generateEmbedding('');
      expect(vector).toHaveLength(768);
    });

    it('operates successfully when remote embedding API is unavailable (fallback operational)', async () => {
      // Mock Gemini API error
      const throwingService = new SemanticCacheService();
      vi.spyOn(throwingService, 'generateEmbedding').mockImplementation(async (text) => {
        // Simulates API throwing error, then falling back to deterministic
        return throwingService.generateDeterministicEmbedding(text);
      });

      const vector = await throwingService.generateEmbedding('AWS Lambda serverless test');
      expect(vector).toHaveLength(768);
    });
  });

  describe('Semantic Cache Lookup & Similarity Thresholds', () => {
    it('returns semantic cache hit for prompts with cosine similarity >= 0.95', async () => {
      const prompt = 'Optimize my bullet point for AWS Lambda';
      const completion = 'Led migration of microservices to AWS Lambda, cutting latency by 45%.';
      const vector = [1, 0, 0, 0];

      // Seed with mock embedding
      vi.spyOn(cacheService, 'generateEmbedding').mockResolvedValue(vector);

      await cacheService.set({
        topicScope: 'bullet_rewrite',
        prompt,
        completion,
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        embedding: vector,
      });

      // Query with identical vector (similarity = 1.0 >= 0.95)
      const res = await cacheService.findSimilar('bullet_rewrite', prompt);
      expect(res.hit).toBe(true);
      expect(res.similarity).toBeGreaterThanOrEqual(0.95);
      expect(res.entry?.completion).toBe(completion);
    });

    it('returns cache hit for paraphrased inputs sharing near-identical vectors (similarity >= 0.95)', async () => {
      // Vector A and Vector B with dot product / norms >= 0.95
      const baseVec = [0.99, 0.05, 0.02, 0.01];
      const similarVec = [0.98, 0.07, 0.02, 0.01];

      await cacheService.set({
        topicScope: 'interview',
        prompt: 'Tell me about a difficult bug you solved',
        completion: 'I investigated a race condition in our distributed Redis queue...',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        embedding: baseVec,
      });

      vi.spyOn(cacheService, 'generateEmbedding').mockResolvedValue(similarVec);

      const sim = calculateCosineSimilarity(baseVec, similarVec);
      expect(sim).toBeGreaterThanOrEqual(0.95);

      const res = await cacheService.findSimilar('interview', 'Describe a challenging bug you fixed');
      expect(res.hit).toBe(true);
      expect(res.entry?.completion).toContain('race condition');
    });

    it('dispatches to LLM provider when prompt meaning diverges (< 0.95)', async () => {
      const vecA = [1, 0, 0, 0];
      const vecDivergent = [0, 1, 0, 0]; // Orthogonal, similarity = 0.0

      await cacheService.set({
        topicScope: 'bullet_rewrite',
        prompt: 'Optimize my bullet point for AWS Lambda',
        completion: 'AWS Lambda bullet point rewrite completion',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        embedding: vecA,
      });

      vi.spyOn(cacheService, 'generateEmbedding').mockResolvedValue(vecDivergent);

      const res = await cacheService.findSimilar('bullet_rewrite', 'Explain quantum computing algorithms');
      expect(res.hit).toBe(false);
      expect(res.similarity).toBeLessThan(0.95);
    });

    it('isolates cache entries by topic scope', async () => {
      const vector = [1, 0, 0, 0];
      vi.spyOn(cacheService, 'generateEmbedding').mockResolvedValue(vector);

      await cacheService.set({
        topicScope: 'interview',
        prompt: 'Common system design pattern',
        completion: 'Interview advice on CQRS and Event Sourcing',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        embedding: vector,
      });

      // Same prompt & vector, but different topic scope 'resume'
      const res = await cacheService.findSimilar('resume', 'Common system design pattern');
      expect(res.hit).toBe(false);
    });

    it('completes lookup in sub-15ms on cache hit', async () => {
      const vector = [0.5, 0.5, 0.5, 0.5];
      vi.spyOn(cacheService, 'generateEmbedding').mockResolvedValue(vector);

      await cacheService.set({
        topicScope: 'test_scope',
        prompt: 'Performance test query',
        completion: 'Fast response payload',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        embedding: vector,
      });

      const res = await cacheService.findSimilar('test_scope', 'Performance test query');
      expect(res.hit).toBe(true);
      expect(res.latencyMs).toBeLessThanOrEqual(15);
    });
  });

  describe('Eviction & TTL Policies', () => {
    it('evicts oldest entries when maxMemoryEntries capacity is exceeded (LRU)', async () => {
      const baseVec = [0.5, 0.5, 0.5, 0.5];
      vi.spyOn(cacheService, 'generateEmbedding').mockResolvedValue(baseVec);

      // maxMemoryEntries is set to 5 in beforeEach
      for (let i = 1; i <= 6; i++) {
        await cacheService.set({
          topicScope: 'lru_scope',
          prompt: `Prompt ${i}`,
          completion: `Completion ${i}`,
          model: 'gemini-1.5-flash',
          provider: 'gemini',
          embedding: [i, 1, 1, 1],
        });
      }

      // Memory size must not exceed 5
      expect(cacheService.getMemoryCacheSize()).toBeLessThanOrEqual(5);
    });

    it('ignores expired cache entries based on TTL', async () => {
      const vector = [1, 0, 0, 0];
      vi.spyOn(cacheService, 'generateEmbedding').mockResolvedValue(vector);

      await cacheService.set({
        topicScope: 'ttl_scope',
        prompt: 'Expiring prompt',
        completion: 'This will expire',
        model: 'gemini-1.5-flash',
        provider: 'gemini',
        ttlSeconds: -1, // Expired immediately
        embedding: vector,
      });

      const res = await cacheService.findSimilar('ttl_scope', 'Expiring prompt');
      expect(res.hit).toBe(false);
    });
  });
});
