// backend/src/__tests__/shared/ai/semanticCache.redisearch.test.ts
// Vector index writes and queries, run against an in-memory stand-in for Redis + RediSearch

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SemanticCacheService,
  calculateCosineSimilarity,
  type SemanticCacheEntry,
} from '../../../shared/ai/semanticCache.service.js';

const store = vi.hoisted(() => ({ client: null as any }));

vi.mock('../../../shared/redis/client.js', () => ({
  isRedisConfigured: () => true,
  getRedisClient: () => store.client,
}));

/**
 * Keeps just enough RediSearch behaviour to catch a writer/reader mismatch:
 * only HASH keys under the index prefix are searchable, TAG punctuation must be
 * escaped, and TAG matching ignores case.
 */
function createFakeRedis({ searchModule = true } = {}) {
  const strings = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const hashes = new Map<string, Record<string, string | Buffer>>();
  const ttls = new Map<string, number>();
  let indexPrefix: string | null = null;

  const search = (args: any[]) => {
    const query = String(args[1]);
    const match = /^\(@topicScope:\{(.*)\}\)=>\[KNN 5 @vector \$BLOB AS score\]$/.exec(query);
    const tagSyntax = /^(?:\\[ -/:-@[-^`{-~]|[A-Za-z0-9_])+$/;
    if (!match || !tagSyntax.test(match[1])) throw new Error(`Syntax error in query: ${query}`);

    const scope = match[1].replace(/\\(.)/g, '$1').toLowerCase();
    const blob: Buffer = args[args.indexOf('BLOB') + 1];
    const toFloats = (buf: Buffer) => Array.from({ length: buf.length / 4 }, (_, i) => buf.readFloatLE(i * 4));

    const docs: Array<[string, number, string]> = [];
    for (const [key, hash] of hashes) {
      if (!indexPrefix || !key.startsWith(indexPrefix)) continue;
      if (String(hash.topicScope).toLowerCase() !== scope) continue;
      const vector = hash.vector as Buffer;
      if (vector.length !== blob.length) continue;
      const distance = 1 - calculateCosineSimilarity(toFloats(blob), toFloats(vector));
      docs.push([key, distance, String(hash.payload)]);
    }
    docs.sort((a, b) => a[1] - b[1]);

    return [docs.length, ...docs.flatMap(([key, distance, payload]) => [key, ['score', String(distance), 'payload', payload]])];
  };

  return {
    strings,
    lists,
    hashes,
    ttls,
    call: vi.fn(async (command: string, ...args: any[]) => {
      if (command === 'MODULE') return searchModule ? [['name', 'search', 'ver', 20809]] : [];
      if (!searchModule) throw new Error(`ERR unknown command '${command}'`);
      if (command === 'FT.CREATE') {
        if (indexPrefix) throw new Error('Index already exists');
        indexPrefix = args[args.indexOf('PREFIX') + 2];
        return 'OK';
      }
      if (command === 'FT.SEARCH') return search(args);
      throw new Error(`unexpected command ${command}`);
    }),
    set: vi.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      strings.set(key, value);
      ttls.set(key, ttl);
    }),
    lpush: vi.fn(async (key: string, value: string) => {
      lists.set(key, [value, ...(lists.get(key) ?? [])]);
    }),
    ltrim: vi.fn(async () => 'OK'),
    expire: vi.fn(async (key: string, ttl: number) => {
      ttls.set(key, ttl);
    }),
    lrange: vi.fn(async (key: string) => lists.get(key) ?? []),
    mget: vi.fn(async (...keys: string[]) => keys.map((key) => strings.get(key) ?? null)),
    multi: vi.fn(() => {
      const queued: Array<() => void> = [];
      const tx = {
        hset(key: string, fields: Record<string, string | Buffer>) {
          queued.push(() => hashes.set(key, fields));
          return tx;
        },
        expire(key: string, ttl: number) {
          queued.push(() => ttls.set(key, ttl));
          return tx;
        },
        async exec() {
          return queued.map((run) => {
            run();
            return [null, 1];
          });
        },
      };
      return tx;
    }),
  };
}

const embedding = Array.from({ length: 768 }, (_, i) => (i % 7) / 7);

function createService() {
  const service = new SemanticCacheService({ similarityThreshold: 0.95, defaultTtlSeconds: 600 });
  vi.spyOn(service, 'generateEmbedding').mockResolvedValue(embedding);
  return service;
}

function storeEntry(topicScope: string, vector: number[] = embedding) {
  return createService().set({
    topicScope,
    prompt: 'Optimize my bullet point',
    completion: `completion for ${topicScope}`,
    model: 'gemini-1.5-flash',
    provider: 'gemini',
    embedding: vector,
  });
}

describe('SemanticCacheService RediSearch indexing', () => {
  beforeEach(() => {
    store.client = createFakeRedis();
  });

  it('writes a HASH document under the index prefix with a Float32 vector, payload and TTL', async () => {
    await storeEntry('bullet_rewrite');

    expect(store.client.hashes.size).toBe(1);
    const [key, fields] = [...store.client.hashes][0] as [string, Record<string, any>];
    const entry = JSON.parse(fields.payload) as SemanticCacheEntry;
    expect(key).toBe(`devtrack:ai:sem_cache_idx:${entry.id}`);
    expect(fields.topicScope).toBe('bullet_rewrite');
    expect(Buffer.isBuffer(fields.vector)).toBe(true);
    expect(fields.vector).toEqual(Buffer.from(new Float32Array(embedding).buffer));
    expect(entry.completion).toBe('completion for bullet_rewrite');
    expect(store.client.ttls.get(key)).toBe(600);

    // The linear-scan fallback keys are still written and the scope list stays capped
    const fallbackKey = `devtrack:ai:sem_cache:bullet_rewrite:${entry.id}`;
    expect(store.client.strings.get(fallbackKey)).toBe(fields.payload);
    expect(store.client.lists.get('devtrack:ai:sem_scope:bullet_rewrite')).toEqual([entry.id]);
    expect(store.client.ltrim).toHaveBeenCalledWith('devtrack:ai:sem_scope:bullet_rewrite', 0, 199);
  });

  it('serves a hit from FT.SEARCH to a process with an empty memory cache', async () => {
    await storeEntry('bullet_rewrite');

    const result = await createService().findSimilar('bullet_rewrite', 'Optimize my bullet point');

    expect(result.hit).toBe(true);
    expect(result.similarity).toBeCloseTo(1, 5);
    expect(result.entry?.completion).toBe('completion for bullet_rewrite');
    expect(store.client.call).toHaveBeenCalledWith(
      'FT.SEARCH', 'idx:semantic_cache', expect.any(String),
      'RETURN', '2', 'score', 'payload',
      'PARAMS', '2', 'BLOB', expect.any(Buffer),
      'SORTBY', 'score', 'DIALECT', '2'
    );
    expect(store.client.lrange).not.toHaveBeenCalled();
  });

  it.each(['dsa:medium', 'system-design', 'resume.rewrite/v2', 'mock interview', 'x|y}{z*\\w'])(
    'searches the scope %j without a query syntax error',
    async (scope) => {
      await storeEntry(scope);

      const result = await createService().findSimilar(scope, 'Optimize my bullet point');

      expect(result.hit).toBe(true);
      expect(result.entry?.topicScope).toBe(scope);
      expect(store.client.lrange).not.toHaveBeenCalled();
    }
  );

  it('backslash-escapes TAG punctuation in the query string', async () => {
    await createService().findSimilar('dsa:system-design', 'anything');

    expect(store.client.call).toHaveBeenCalledWith(
      'FT.SEARCH', 'idx:semantic_cache',
      '(@topicScope:{dsa\\:system\\-design})=>[KNN 5 @vector $BLOB AS score]',
      'RETURN', '2', 'score', 'payload',
      'PARAMS', '2', 'BLOB', expect.any(Buffer),
      'SORTBY', 'score', 'DIALECT', '2'
    );
  });

  it('skips an index match whose scope differs only by case', async () => {
    await storeEntry('Interview');

    const result = await createService().findSimilar('interview', 'Optimize my bullet point');

    expect(result.hit).toBe(false);
  });

  it('writes only the fallback keys when RediSearch is not loaded', async () => {
    store.client = createFakeRedis({ searchModule: false });

    await storeEntry('bullet_rewrite');
    const result = await createService().findSimilar('bullet_rewrite', 'Optimize my bullet point');

    expect(result.hit).toBe(true);
    expect(store.client.hashes.size).toBe(0);
    expect(store.client.strings.size).toBe(1);
    expect(store.client.call.mock.calls.every(([command]: string[]) => command === 'MODULE')).toBe(true);
  });

  it.each([
    ['a different dimension', [1, 0, 0]],
    ['a non-finite value', [Number.NaN, ...embedding.slice(1)]],
    ['only zeros', new Array(768).fill(0)],
  ])('does not index an embedding with %s', async (_label, vector) => {
    await storeEntry('bullet_rewrite', vector);

    expect(store.client.hashes.size).toBe(0);
    expect(store.client.strings.size).toBe(1);
  });
});

describe('calculateCosineSimilarity input guards', () => {
  it('returns 0 when the dimensions differ', () => {
    expect(calculateCosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    expect(calculateCosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'returns 0 when either vector contains %s',
    (bad) => {
      expect(calculateCosineSimilarity([1, bad], [1, 0])).toBe(0);
      expect(calculateCosineSimilarity([1, 0], [bad, 0])).toBe(0);
    }
  );

  it('returns 0 instead of NaN when the sums overflow', () => {
    expect(calculateCosineSimilarity([1e200, 1e200], [1e200, 1e200])).toBe(0);
  });
});
