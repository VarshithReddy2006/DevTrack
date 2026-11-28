// src/shared/ai/semanticCache.service.ts — Semantic Prompt Caching Service
// Evaluates embedding-based vector cosine similarity (threshold >= 0.95)
// Supports Redis Vector Search (FT.SEARCH / JSON or HASH) with in-memory LRU vector cache fallback.

import crypto from 'crypto';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';
import { getRedisClient, isRedisConfigured } from '../redis/client.js';
import { logger } from '../logger.js';
import env from '../../config/env.js';
import { AIProviderAdapter } from '../../modules/ai/provider/AIProviderAdapter.js';

export interface SemanticCacheEntry {
  id: string;
  topicScope: string;
  prompt: string;
  completion: string;
  embedding: number[];
  model: string;
  provider: string;
  tokensUsed: number;
  createdAt: number;
  ttlSeconds: number;
}

export interface SemanticLookupResult {
  hit: boolean;
  similarity: number;
  entry?: SemanticCacheEntry;
  latencyMs: number;
}

export interface SemanticCacheOptions {
  similarityThreshold?: number;
  defaultTtlSeconds?: number;
  maxMemoryEntries?: number;
}

const VECTOR_INDEX_NAME = 'idx:semantic_cache';
const VECTOR_INDEX_PREFIX = 'devtrack:ai:sem_cache_idx:';
const VECTOR_DIMENSIONS = 768;

/**
 * Calculates cosine similarity: dot(A, B) / (norm(A) * norm(B))
 * Returns 0 for mismatched dimensions or non-finite values.
 */
export function calculateCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    if (!Number.isFinite(vecA[i]) || !Number.isFinite(vecB[i])) return 0;
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  // Very large values can overflow to Infinity above
  return Number.isFinite(similarity) ? similarity : 0;
}

/**
 * Backslash-escapes ASCII punctuation and whitespace so RediSearch reads the
 * value literally inside a TAG {...} clause.
 */
function escapeTagValue(value: string): string {
  return value.replace(/[ \t\n\r\f\v!-/:-@[-^`{-~]/g, '\\$&');
}

export class SemanticCacheService {
  private readonly similarityThreshold: number;
  private readonly defaultTtlSeconds: number;
  private readonly maxMemoryEntries: number;

  // In-memory LRU vector cache fallback Map: key -> SemanticCacheEntry
  private memoryCache: Map<string, SemanticCacheEntry> = new Map();
  private redisVectorSearchAvailable: boolean | null = null;
  private indexInitialized = false;

  constructor(options: SemanticCacheOptions = {}) {
    this.similarityThreshold = options.similarityThreshold ?? env.SEMANTIC_CACHE_SIMILARITY_THRESHOLD ?? 0.95;
    this.defaultTtlSeconds = options.defaultTtlSeconds ?? env.SEMANTIC_CACHE_TTL_SECONDS ?? 7 * 24 * 60 * 60;
    this.maxMemoryEntries = options.maxMemoryEntries ?? 1000;
  }

  /**
   * Generates a normalized embedding vector for the given text.
   * Uses Gemini text-embedding-004 API when configured, or a deterministic fallback vector.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const trimmed = text.trim();
    if (!trimmed) {
      return new Array(768).fill(0);
    }

    const apiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    const isGeminiDown = typeof AIProviderAdapter?.getProviderHealth === 'function'
      ? AIProviderAdapter.getProviderHealth('gemini')?.status === 'down'
      : false;
    if (apiKey && apiKey !== 'dummy_key_for_dev' && !isGeminiDown) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
        const res = await embeddingModel.embedContent({
          content: { role: 'user', parts: [{ text: trimmed }] },
          taskType: TaskType.SEMANTIC_SIMILARITY,
        });
        if (res.embedding?.values && Array.isArray(res.embedding.values) && res.embedding.values.length > 0) {
          return res.embedding.values;
        }
      } catch (err) {
        logger.warn('[SemanticCache] Gemini embedding generation failed, falling back to local generator', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Local deterministic embedding fallback (768 dimensions)
    return this.generateDeterministicEmbedding(trimmed);
  }

  /**
   * Deterministic local embedding generator (768 dimensions)
   * Produces vectors that capture word frequency, character n-grams, and semantic positional cues.
   * Stopwords are down-weighted so topical semantic keywords drive the vector angle.
   */
  generateDeterministicEmbedding(text: string): number[] {
    const dimensions = 768;
    const vector = new Array<number>(dimensions).fill(0);

    const stopwords = new Set([
      'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'my', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been'
    ]);

    const normalized = text.toLowerCase().trim();
    const words = normalized.split(/\s+/).filter(Boolean);

    // 1. Word token hashing into vector components
    for (const word of words) {
      const weight = stopwords.has(word) ? 0.2 : 1.0;
      const hash = crypto.createHash('sha256').update(word).digest();
      for (let i = 0; i < 32; i++) {
        const val = ((hash[i] / 255) * 2 - 1) * weight; // [-weight, weight]
        const targetIdx = (hash[i] * 31 + i * 17) % dimensions;
        vector[targetIdx] += val;
      }
    }

    // 2. Bigrams / Trigrams for phrase similarity
    for (let i = 0; i < words.length - 1; i++) {
      const w1 = words[i];
      const w2 = words[i + 1];
      const weight = (stopwords.has(w1) && stopwords.has(w2)) ? 0.15 : 0.6;
      const phrase = `${w1} ${w2}`;
      const hash = crypto.createHash('md5').update(phrase).digest();
      for (let j = 0; j < 16; j++) {
        const val = ((hash[j] / 255) * 2 - 1) * weight;
        const targetIdx = (hash[j] * 23 + j * 13) % dimensions;
        vector[targetIdx] += val;
      }
    }

    // 3. Normalize vector to unit length (L2 norm)
    let sumSquares = 0;
    for (let i = 0; i < dimensions; i++) {
      sumSquares += vector[i] * vector[i];
    }

    if (sumSquares === 0) {
      // Empty or neutral: fill with small deterministic seed
      const hash = crypto.createHash('sha256').update(normalized).digest();
      for (let i = 0; i < dimensions; i++) {
        vector[i] = (hash[i % hash.length] / 255) * 0.1;
      }
      return vector;
    }

    const norm = Math.sqrt(sumSquares);
    for (let i = 0; i < dimensions; i++) {
      vector[i] = vector[i] / norm;
    }

    return vector;
  }

  /**
   * Finds a cached response with cosine similarity >= similarityThreshold within topicScope.
   */
  async findSimilar(topicScope: string, prompt: string): Promise<SemanticLookupResult> {
    const startTime = Date.now();

    try {
      // Clean expired memory cache entries
      this.evictExpiredMemoryEntries();

      // 1. Generate query embedding
      const queryVector = await this.generateEmbedding(prompt);

      // 2. Query Redis Vector Index if available
      if (isRedisConfigured()) {
        const redisResult = await this.searchRedisVector(topicScope, queryVector, prompt);
        if (redisResult && redisResult.hit) {
          return {
            ...redisResult,
            latencyMs: Math.max(1, Date.now() - startTime),
          };
        }
      }

      // 3. In-memory LRU Cosine Similarity Search fallback
      const memoryResult = this.searchMemoryCache(topicScope, queryVector);
      return {
        ...memoryResult,
        latencyMs: Math.max(1, Date.now() - startTime),
      };
    } catch (err) {
      logger.warn('[SemanticCache] findSimilar lookup error, proceeding without semantic hit', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        hit: false,
        similarity: 0,
        latencyMs: Math.max(1, Date.now() - startTime),
      };
    }
  }

  /**
   * Stores a completion and its embedding vector in the semantic cache.
   */
  async set(entry: {
    topicScope: string;
    prompt: string;
    completion: string;
    model: string;
    provider: string;
    tokensUsed?: number;
    ttlSeconds?: number;
    embedding?: number[];
  }): Promise<void> {
    try {
      const ttlSeconds = entry.ttlSeconds ?? this.defaultTtlSeconds;
      const embedding = entry.embedding ?? (await this.generateEmbedding(entry.prompt));
      const id = crypto.randomUUID();
      const now = Date.now();

      const record: SemanticCacheEntry = {
        id,
        topicScope: entry.topicScope,
        prompt: entry.prompt,
        completion: entry.completion,
        embedding,
        model: entry.model,
        provider: entry.provider,
        tokensUsed: entry.tokensUsed ?? 0,
        createdAt: now,
        ttlSeconds,
      };

      // Store in memory LRU
      this.addToMemory(record);

      // Store in Redis
      if (isRedisConfigured()) {
        await this.storeInRedis(record);
      }
    } catch (err) {
      logger.warn('[SemanticCache] Failed to store semantic cache entry', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Searches the in-memory cache using Cosine Similarity.
   */
  private searchMemoryCache(topicScope: string, queryVector: number[]): { hit: boolean; similarity: number; entry?: SemanticCacheEntry } {
    let bestSimilarity = -1;
    let bestEntry: SemanticCacheEntry | undefined;

    const now = Date.now();

    for (const [key, entry] of this.memoryCache.entries()) {
      // Check expiration
      if (entry.createdAt + entry.ttlSeconds * 1000 < now) {
        this.memoryCache.delete(key);
        continue;
      }

      // Check topic scope match
      if (entry.topicScope !== topicScope) {
        continue;
      }

      const similarity = calculateCosineSimilarity(queryVector, entry.embedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestEntry = entry;
      }
    }

    if (bestSimilarity >= this.similarityThreshold && bestEntry) {
      // Refresh LRU order on hit
      this.memoryCache.delete(bestEntry.id);
      this.memoryCache.set(bestEntry.id, bestEntry);

      return {
        hit: true,
        similarity: bestSimilarity,
        entry: bestEntry,
      };
    }

    return {
      hit: false,
      similarity: Math.max(0, bestSimilarity),
      entry: bestEntry,
    };
  }

  /**
   * Inserts or refreshes an entry in the LRU in-memory map.
   */
  private addToMemory(entry: SemanticCacheEntry): void {
    if (this.memoryCache.has(entry.id)) {
      this.memoryCache.delete(entry.id);
    } else if (this.memoryCache.size >= this.maxMemoryEntries) {
      // Evict oldest (first inserted in Map iterator)
      const oldestKey = this.memoryCache.keys().next().value;
      if (oldestKey) {
        this.memoryCache.delete(oldestKey);
      }
    }
    this.memoryCache.set(entry.id, entry);
  }

  /**
   * Evicts expired records from memory cache.
   */
  private evictExpiredMemoryEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.createdAt + entry.ttlSeconds * 1000 < now) {
        this.memoryCache.delete(key);
      }
    }
  }

  /**
   * Stores entry in Redis: scoped string keys for the linear scan, plus a HASH
   * document for the vector index when RediSearch is loaded.
   */
  private async storeInRedis(entry: SemanticCacheEntry): Promise<void> {
    try {
      const redis = getRedisClient();
      const redisKey = `devtrack:ai:sem_cache:${entry.topicScope}:${entry.id}`;
      const payload = JSON.stringify(entry);

      await redis.set(redisKey, payload, 'EX', entry.ttlSeconds);

      // Also maintain a scoped index list of recent entries for fallback linear search
      const scopeListKey = `devtrack:ai:sem_scope:${entry.topicScope}`;
      await redis.lpush(scopeListKey, entry.id);
      await redis.ltrim(scopeListKey, 0, 199); // Keep latest 200 items per scope
      await redis.expire(scopeListKey, entry.ttlSeconds);

      if (this.isIndexableEmbedding(entry.embedding) && (await this.isVectorSearchAvailable())) {
        await this.ensureRedisIndex();
        await this.storeVectorDocument(entry, payload);
      }
    } catch (err) {
      logger.warn('[SemanticCache] Redis store error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Writes the HASH document that the vector index picks up by key prefix.
   */
  private async storeVectorDocument(entry: SemanticCacheEntry, payload: string): Promise<void> {
    const key = `${VECTOR_INDEX_PREFIX}${entry.id}`;
    // MULTI so a document is never left behind without a TTL
    const results = await getRedisClient()
      .multi()
      .hset(key, {
        topicScope: entry.topicScope,
        vector: Buffer.from(new Float32Array(entry.embedding).buffer),
        payload,
      })
      .expire(key, entry.ttlSeconds)
      .exec();

    const failure = results?.find(([err]) => err)?.[0];
    if (failure) throw failure;
  }

  /**
   * The index has a fixed dimension, and a zero vector has no cosine distance.
   */
  private isIndexableEmbedding(embedding: number[]): boolean {
    return (
      embedding.length === VECTOR_DIMENSIONS &&
      embedding.every((value) => Number.isFinite(value)) &&
      embedding.some((value) => value !== 0)
    );
  }

  /**
   * Checks once whether the RediSearch module is loaded.
   */
  private async isVectorSearchAvailable(): Promise<boolean> {
    if (this.redisVectorSearchAvailable === null) {
      try {
        const modules = await getRedisClient().call('MODULE', 'LIST') as unknown[];
        this.redisVectorSearchAvailable = Array.isArray(modules) && modules.some((m: unknown) => {
          if (Array.isArray(m)) {
            return m.includes('search');
          }
          return false;
        });
      } catch {
        this.redisVectorSearchAvailable = false;
      }
    }
    return this.redisVectorSearchAvailable;
  }

  /**
   * Searches Redis using Vector Index (FT.SEARCH) if available, or scans scoped entries.
   */
  private async searchRedisVector(
    topicScope: string,
    queryVector: number[],
    prompt: string
  ): Promise<{ hit: boolean; similarity: number; entry?: SemanticCacheEntry } | null> {
    try {
      const redis = getRedisClient();

      // If RediSearch is available, execute FT.SEARCH vector query
      if (await this.isVectorSearchAvailable()) {
        try {
          await this.ensureRedisIndex();
          const floatBuffer = Buffer.from(new Float32Array(queryVector).buffer);
          const rawResult = await redis.call(
            'FT.SEARCH',
            VECTOR_INDEX_NAME,
            `(@topicScope:{${escapeTagValue(topicScope)}})=>[KNN 5 @vector $BLOB AS score]`,
            'RETURN',
            '2',
            'score',
            'payload',
            'PARAMS',
            '2',
            'BLOB',
            floatBuffer,
            'SORTBY',
            'score',
            'DIALECT',
            '2'
          ) as unknown[];

          if (Array.isArray(rawResult) && rawResult.length > 1) {
            // Parse RediSearch results
            for (let i = 1; i < rawResult.length; i += 2) {
              const fields = rawResult[i + 1];
              if (Array.isArray(fields)) {
                let score = 1;
                let payloadStr = '';
                for (let j = 0; j < fields.length; j += 2) {
                  if (fields[j] === 'score') score = parseFloat(fields[j + 1]);
                  if (fields[j] === 'payload') payloadStr = fields[j + 1];
                }
                const similarity = 1 - score; // Cosine distance to similarity
                if (similarity >= this.similarityThreshold && payloadStr) {
                  const entry = JSON.parse(payloadStr) as SemanticCacheEntry;
                  // TAG matching ignores case and splits on commas, so confirm the exact scope
                  if (entry.topicScope === topicScope) {
                    return { hit: true, similarity, entry };
                  }
                }
              }
            }
          }
        } catch (ftErr) {
          logger.debug('[SemanticCache] FT.SEARCH query skipped or failed, falling back to scoped scan', {
            error: ftErr instanceof Error ? ftErr.message : String(ftErr),
          });
        }
      }

      // Fallback: Scoped linear scan over recent Redis entries in this topicScope
      const scopeListKey = `devtrack:ai:sem_scope:${topicScope}`;
      const recentIds = await redis.lrange(scopeListKey, 0, 99);
      if (!recentIds || recentIds.length === 0) {
        return null;
      }

      const keys = recentIds.map((id) => `devtrack:ai:sem_cache:${topicScope}:${id}`);
      const rawEntries = await redis.mget(...keys);

      let bestSimilarity = -1;
      let bestEntry: SemanticCacheEntry | undefined;

      for (const raw of rawEntries) {
        if (!raw) continue;
        try {
          const entry = JSON.parse(raw) as SemanticCacheEntry;
          if (entry.topicScope === topicScope && Array.isArray(entry.embedding)) {
            const sim = calculateCosineSimilarity(queryVector, entry.embedding);
            if (sim > bestSimilarity) {
              bestSimilarity = sim;
              bestEntry = entry;
            }
          }
        } catch {
          // ignore malformed
        }
      }

      if (bestSimilarity >= this.similarityThreshold && bestEntry) {
        return {
          hit: true,
          similarity: bestSimilarity,
          entry: bestEntry,
        };
      }

      return bestEntry ? { hit: false, similarity: bestSimilarity, entry: bestEntry } : null;
    } catch (err) {
      logger.warn('[SemanticCache] searchRedisVector encountered error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Initializes Redis Search Index for semantic vectors if not already initialized.
   */
  private async ensureRedisIndex(): Promise<void> {
    if (this.indexInitialized) return;
    try {
      const redis = getRedisClient();
      await redis.call(
        'FT.CREATE',
        VECTOR_INDEX_NAME,
        'ON',
        'HASH',
        'PREFIX',
        '1',
        VECTOR_INDEX_PREFIX,
        'SCHEMA',
        'topicScope',
        'TAG',
        'vector',
        'VECTOR',
        'HNSW',
        '6',
        'TYPE',
        'FLOAT32',
        'DIM',
        String(VECTOR_DIMENSIONS),
        'DISTANCE_METRIC',
        'COSINE'
      );
      this.indexInitialized = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Index already exists') || msg.includes('BUSYKEY')) {
        this.indexInitialized = true;
      }
    }
  }

  /**
   * Clears the in-memory cache and resets cached state (useful for testing).
   */
  clearMemoryCache(): void {
    this.memoryCache.clear();
    this.redisVectorSearchAvailable = null;
    this.indexInitialized = false;
  }

  /**
   * Returns current count of items in in-memory cache.
   */
  getMemoryCacheSize(): number {
    return this.memoryCache.size;
  }
}

export const semanticCacheService = new SemanticCacheService();
