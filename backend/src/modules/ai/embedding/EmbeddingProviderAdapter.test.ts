import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingProviderAdapter } from './EmbeddingProviderAdapter.js';

vi.unmock('./EmbeddingProviderAdapter.js');

const { cache, get, set, openai, gemini } = vi.hoisted(() => {
  const cache = new Map<string, string>();
  return {
    cache,
    get: vi.fn(async (key: string) => cache.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { cache.set(key, value); }),
    openai: vi.fn(async ({ input }: { input: string[] }) => ({
      data: input.map((text, index) => ({
        index,
        embedding: Array(1536).fill(text.charCodeAt(text.length - 1)),
      })).reverse(),
    })),
    gemini: vi.fn(async () => ({ embedding: { values: Array(3072).fill(2) } })),
  };
});
vi.mock('../../../shared/redis/index.js', () => ({
  getRedisClient: () => ({ get, set }),
  getRedisHealth: () => ({ status: 'connected' }),
}));
vi.mock('openai', () => ({ default: class { embeddings = { create: openai }; } }));
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class { getGenerativeModel() { return { embedContent: gemini }; } },
}));

const owner = { scope: 'user', userId: '000000000000000000000001' } as const;
const otherOwner = { scope: 'user', userId: '000000000000000000000002' } as const;

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key');
  vi.stubEnv('GEMINI_API_KEY', '');
  cache.clear();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe('embedding cache identity', () => {
  it('separates full text, tenant and model, and reads only new cache entries', async () => {
    const adapter = new EmbeddingProviderAdapter();
    const prefix = 'x'.repeat(500);
    const texts = [prefix + 'a', prefix + 'b'];
    const legacyKey = 'ai:embedding:v2:' + Buffer.from(texts[0]).toString('base64').slice(0, 100);
    cache.set(legacyKey, JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536, vector: Array(1536).fill(99) }));

    const vectors = await adapter.generateEmbeddingBatch(texts, owner);
    expect(vectors.map(result => result.vector[0])).toEqual([97, 98]);
    expect(set).toHaveBeenCalledTimes(2);
    const [firstKey, secondKey] = set.mock.calls.map(([key]) => key);
    expect(firstKey).toMatch(/^ai:embedding:v3:[a-f0-9]{64}$/);
    expect(secondKey).not.toBe(firstKey);
    expect(get.mock.calls.flat()).not.toContain(legacyKey);
    expect(await adapter.generateEmbeddingBatch(texts, owner)).toEqual(vectors);
    expect(openai).toHaveBeenCalledTimes(1);

    await adapter.generateEmbedding(texts[0], otherOwner);
    expect(openai).toHaveBeenCalledTimes(2);
    expect(set.mock.lastCall?.[0]).not.toBe(firstKey);

    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', 'synthetic-gemini-key');
    expect(await adapter.generateEmbedding(texts[0], owner)).toMatchObject({
      provider: 'gemini', model: 'gemini-embedding-2', dimensions: 3072,
    });
    expect(gemini).toHaveBeenCalledOnce();
    expect(set.mock.lastCall?.[0]).not.toBe(firstKey);
  });

  it('treats malformed or wrong-dimension cache entries as misses', async () => {
    const adapter = new EmbeddingProviderAdapter();
    await adapter.generateEmbedding('first', owner);
    const key = set.mock.lastCall![0];
    cache.set(key, '{not valid JSON');
    await adapter.generateEmbedding('first', owner);
    cache.set(key, JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536, vector: [5] }));
    const result = await adapter.generateEmbedding('first', owner);
    expect(result.vector).toHaveLength(1536);
    expect(openai).toHaveBeenCalledTimes(3);
  });

  it('keeps inputs without a scope and placeholder results out of Redis', async () => {
    const adapter = new EmbeddingProviderAdapter();
    await adapter.generateEmbedding('transient');
    expect(openai).toHaveBeenCalledOnce();
    vi.stubEnv('OPENAI_API_KEY', '');
    const vectors = await adapter.generateEmbeddingBatch(['same length A', 'same length B'], owner);
    expect(vectors[0].vector).not.toEqual(vectors[1].vector);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});
