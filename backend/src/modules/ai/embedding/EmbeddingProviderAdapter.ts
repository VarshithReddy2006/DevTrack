import { createHash } from 'node:crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { logger } from '../../../shared/logger.js';
import { getRedisClient, getRedisHealth } from '../../../shared/redis/index.js';
import { EMBEDDING_VERSION, embeddingScopeFilter, type EmbeddingScope } from './embeddingScope.js';

export interface EmbeddingResponse {
  vector: number[];
  provider: 'openai' | 'gemini';
  dimensions: number;
  model: string;
}

const OPENAI = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 } as const;
const GEMINI = { provider: 'gemini', model: 'gemini-embedding-2', dimensions: 3072 } as const;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 15_000;
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

function cacheKey(text: string, owner: ReturnType<typeof embeddingScopeFilter>, model: Omit<EmbeddingResponse, 'vector'>): string {
  const hash = createHash('sha256').update(JSON.stringify([
    owner.scope, owner.userId?.toHexString(), model.provider, model.model, model.dimensions, EMBEDDING_VERSION, text,
  ])).digest('hex');
  return `ai:embedding:v3:${hash}`;
}

function matchesModel(value: unknown, model: Omit<EmbeddingResponse, 'vector'>): value is EmbeddingResponse {
  if (!value || typeof value !== 'object') return false;
  const embedding = value as Partial<EmbeddingResponse>;
  return embedding.provider === model.provider && embedding.model === model.model
    && embedding.dimensions === model.dimensions && Array.isArray(embedding.vector)
    && embedding.vector.length === model.dimensions && embedding.vector.every(Number.isFinite);
}

export class EmbeddingProviderAdapter {
  private async withRetry<T>(operation: () => Promise<T>, context: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${context} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
          }),
        ]);
      } catch (error) {
        lastError = error;
        logger.warn(`[EmbeddingProvider] Attempt ${attempt}/${MAX_RETRIES} failed for ${context}`);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < MAX_RETRIES) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
    throw new Error(`[EmbeddingProvider] Failed ${context} after ${MAX_RETRIES} attempts`, { cause: lastError });
  }

  async generateEmbeddingBatch(texts: string[], scope?: EmbeddingScope): Promise<EmbeddingResponse[]> {
    if (!texts.length) return [];
    const owner = scope === undefined ? undefined : embeddingScopeFilter(scope);
    const openAiKey = process.env.OPENAI_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    const model = openAiKey && !openAiKey.startsWith('sk-or-') ? OPENAI
      : geminiKey && geminiKey !== 'dummy_key_for_dev' ? GEMINI
      : null;
    if (!model) {
      logger.warn('[EmbeddingProvider] No valid API key configured. Using deterministic placeholder vectors.');
      return texts.map(text => {
        const hash = createHash('sha256').update(text).digest();
        const vector = Array.from({ length: OPENAI.dimensions }, (_, i) => Math.sin(i + hash[i % hash.length]) * 0.1);
        return { vector, provider: 'gemini', model: 'deterministic-fallback-v1', dimensions: vector.length };
      });
    }

    // Caller-owned text without a verified scope is transient and never cached.
    const redisClient = owner ? getRedisClient() : undefined;
    const redis = redisClient && getRedisHealth().status === 'connected' ? redisClient : undefined;
    const keys = owner && redis ? texts.map(text => cacheKey(text, owner, model)) : [];
    const results = await Promise.all(texts.map(async (_, index): Promise<EmbeddingResponse | undefined> => {
      if (!redis) return undefined;
      try {
        const cached = await redis.get(keys[index]);
        const value: unknown = cached ? JSON.parse(cached) : undefined;
        return matchesModel(value, model) ? value : undefined;
      } catch {
        return undefined;
      }
    }));
    const missing = results.flatMap((result, index) => result ? [] : [index]);
    if (missing.length) {
      const input = missing.map(index => texts[index]);
      const vectors = await this.withRetry(async () => {
        const vectors = model.provider === 'openai'
          ? await this.embedWithOpenAI(openAiKey!, input)
          : await this.embedWithGemini(geminiKey!, input);
        if (vectors.length !== input.length || vectors.some(vector => (
          !Array.isArray(vector) || vector.length !== model.dimensions || !vector.every(Number.isFinite)
        ))) {
          throw new Error('Embedding provider returned unexpected vector dimensions or batch size');
        }
        return vectors;
      }, `${model.provider} batch embedding`);

      await Promise.all(missing.map(async (index, position) => {
        const embedding = { ...model, vector: vectors[position] };
        results[index] = embedding;
        if (redis) {
          await redis.set(keys[index], JSON.stringify(embedding), 'EX', CACHE_TTL_SECONDS).catch(() => {
            logger.warn('[EmbeddingProvider] Failed to cache embedding');
          });
        }
      }));
    }
    return results as EmbeddingResponse[];
  }

  async generateEmbedding(text: string, scope?: EmbeddingScope): Promise<EmbeddingResponse> {
    const [embedding] = await this.generateEmbeddingBatch([text], scope);
    return embedding;
  }

  private async embedWithOpenAI(apiKey: string, input: string[]): Promise<number[][]> {
    const client = new OpenAI({ apiKey });
    const response = await client.embeddings.create({ model: OPENAI.model, dimensions: OPENAI.dimensions, input });
    const ordered = [...response.data].sort((left, right) => left.index - right.index);
    if (ordered.some((item, index) => item.index !== index)) throw new Error('Invalid OpenAI embedding indices');
    return ordered.map(item => item.embedding);
  }

  private async embedWithGemini(apiKey: string, input: string[]): Promise<number[][]> {
    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: GEMINI.model });
    return Promise.all(input.map(async text => (await model.embedContent(text)).embedding.values));
  }
}
