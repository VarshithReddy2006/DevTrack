import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { Embedding } from '../../../db/models/embedding.model.js';
import { VectorRetrievalEngine } from '../retrieval/VectorRetrievalEngine.js';
import { EmbeddingPersistenceLayer } from './EmbeddingPersistenceLayer.js';
import type { EmbeddingScope } from './embeddingScope.js';

const store = new EmbeddingPersistenceLayer();
const tenant = (): EmbeddingScope => ({ scope: 'user', userId: new Types.ObjectId().toHexString() });
const globalScope = { scope: 'global' } as const;
const write = (owner: EmbeddingScope, sessionId: string, vector: number[], chunk = 0) =>
  store.saveEmbedding(owner, sessionId, chunk, vector, 'openai', 'test-model', 'shared synthetic text', 'resume');

describe('embedding storage and retrieval scopes', () => {
  it('keeps identical texts and session IDs independent by owner and chunk', async () => {
    await Embedding.init();
    const alice = tenant();
    const bob = tenant();
    await Promise.all([
      write(alice, 'same-session', [1, 0]),
      write(alice, 'same-session', [1, 0]),
      write(alice, 'same-session', [0, 1], 1),
      write(bob, 'same-session', [0, 1]),
    ]);

    expect(await Embedding.countDocuments()).toBe(3);
    expect(await store.getEmbedding(alice, 'same-session')).toEqual([1, 0]);
    expect(await store.getEmbedding(bob, 'same-session')).toEqual([0, 1]);
    expect(await store.getEmbeddingMetadata(alice, 'same-session')).toMatchObject({ scope: 'user', chunkIndex: 0 });
    expect(await store.getEmbedding(tenant(), 'same-session')).toBeNull();
    await store.deleteEmbedding(alice, 'same-session');
    expect(await Embedding.countDocuments()).toBe(1);
    expect(await store.getEmbedding(bob, 'same-session')).toEqual([0, 1]);
  });

  it('stores distinct content with a shared prefix independently', async () => {
    const owner = tenant();
    const prefix = 'x'.repeat(500);
    await store.saveEmbedding(owner, 'first', 0, [1, 0], 'openai', 'test-model', prefix + 'a', 'resume');
    await store.saveEmbedding(owner, 'second', 0, [0, 1], 'openai', 'test-model', prefix + 'b', 'resume');

    const first = await store.getEmbeddingMetadata(owner, 'first');
    const second = await store.getEmbeddingMetadata(owner, 'second');
    expect(first?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.contentHash).not.toBe(first?.contentHash);
    expect(first?.vector).toEqual([1, 0]);
    expect(second?.vector).toEqual([0, 1]);
  });

  it('ranks only the selected owner or explicitly shared dataset and ignores legacy rows', async () => {
    const alice = tenant();
    const bob = tenant();
    await write(alice, 'alice', [1, 0]);
    await write(alice, 'other-dimensions', [1, 0, 0]);
    await write(bob, 'bob', [1, 0]);
    await store.saveEmbedding(globalScope, 'taxonomy', 0, [1, 0], 'openai', 'test-model', 'taxonomy', 'skill');
    await Embedding.db.collection(Embedding.collection.name).insertOne({
      sessionId: 'legacy',
      userId: new Types.ObjectId(alice.userId),
      contentHash: 'legacy-unscoped-content-hash',
      vector: [1, 0],
      dimensions: 2,
    });

    const retrieval = new VectorRetrievalEngine(store);
    expect(await retrieval.retrieveTopK(alice, [1, 0])).toEqual([{ id: 'alice', score: 1, vector: [1, 0] }]);
    expect(await retrieval.retrieveTopK(globalScope, [1, 0])).toEqual([{ id: 'taxonomy', score: 1, vector: [1, 0] }]);
    expect(await store.getEmbedding(alice, 'legacy')).toBeNull();
    await store.clear(globalScope);
    expect(await store.getEmbedding(bob, 'bob')).toEqual([1, 0]);
  });

  it('rejects missing owners and private content in the shared dataset', async () => {
    const noOwner = { scope: 'user' } as EmbeddingScope;
    await expect(write(noOwner, 'private', [1])).rejects.toThrow('owner');
    await expect(write(globalScope, 'private', [1])).rejects.toThrow('user owner');
    await expect(store.getAllEmbeddings(noOwner, 1)).rejects.toThrow('owner');
    await expect(store.clear(undefined as unknown as EmbeddingScope)).rejects.toThrow('owner');
    await expect(new Embedding({ scope: 'user' }).validate()).rejects.toMatchObject({
      errors: { userId: expect.any(Error) },
    });
  });
});
