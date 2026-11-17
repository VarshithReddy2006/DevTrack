// backend/src/__tests__/modules/ai/embedding-isolation.test.ts
// Per-user embedding uniqueness, user isolation in retrieval, the $vectorSearch / cosine fallback
// switch, and cascade deletes when a resume session goes away.

import { Types } from 'mongoose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Embedding } from '../../../db/models/embedding.model.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import type { EmbeddingScope } from '../../../modules/ai/embedding/embeddingScope.js';
import {
  buildVectorSearchPipeline,
  EmbeddingPersistenceLayer,
} from '../../../modules/ai/embedding/EmbeddingPersistenceLayer.js';
import { VectorRetrievalEngine } from '../../../modules/ai/retrieval/VectorRetrievalEngine.js';

const store = new EmbeddingPersistenceLayer();
const user = (): EmbeddingScope => ({ scope: 'user', userId: new Types.ObjectId().toHexString() });
const globalScope = { scope: 'global' } as const;
const save = (
  owner: EmbeddingScope,
  id: string,
  vector: number[],
  contentType: Parameters<EmbeddingPersistenceLayer['saveEmbedding']>[7] = 'resume_bullet',
  chunk = 0,
  text = 'led a team of four engineers',
) => store.saveEmbedding(owner, id, chunk, vector, 'openai', 'test-model', text, contentType);

beforeAll(async () => {
  await Embedding.init();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('per-user content hash uniqueness', () => {
  it('replaces the global contentHash index with uq_embeddings_user_hash', async () => {
    const indexes = await Embedding.collection.indexes();
    expect(indexes.find(index => index.name === 'uq_embeddings_user_hash')).toMatchObject({
      key: { userId: 1, contentHash: 1 },
      unique: true,
    });
    expect(indexes.filter(index => index.unique && index.key.contentHash === 1 && !index.key.userId)).toEqual([]);
  });

  it('lets two users store the same contentHash but rejects a duplicate for one owner', async () => {
    const row = (userId: Types.ObjectId, sessionId: string) => ({
      sessionId, chunkIndex: 0, scope: 'user', userId, vector: [1, 0], dimensions: 2, provider: 'openai',
      providerModel: 'test-model', content: 'shared bullet', contentHash: 'same-hash', contentType: 'resume_bullet',
      generatedAt: new Date(),
    });
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();

    await expect(Embedding.create(row(alice, 'a'))).resolves.toBeDefined();
    await expect(Embedding.create(row(bob, 'b'))).resolves.toBeDefined();
    await expect(Embedding.create(row(alice, 'c'))).rejects.toMatchObject({ code: 11000 });
    expect(await Embedding.countDocuments({ contentHash: 'same-hash' })).toBe(2);
  });

  it('accepts the v2 content types and rejects unknown ones', async () => {
    const owner = user();
    for (const type of ['resume_bullet', 'project_summary', 'job_requirement', 'interview_answer', 'resume'] as const) {
      await save(owner, `s-${type}`, [1, 0], type);
    }
    expect(await Embedding.countDocuments({ userId: new Types.ObjectId((owner as { userId: string }).userId) })).toBe(5);
    expect((await store.getEmbeddingMetadata(owner, 's-job_requirement'))?.embeddingVersion).toBe('2.0.0');
    await expect(save(owner, 'bad', [1, 0], 'nonsense' as never)).rejects.toThrow(/contentType/);
  });

  it('keeps user content out of the shared dataset', async () => {
    for (const type of ['resume_bullet', 'project_summary', 'job_requirement', 'interview_answer'] as const) {
      await expect(save(globalScope, 'g', [1, 0], type)).rejects.toThrow('user owner');
    }
    await expect(save(globalScope, 'g', [1, 0], 'skill')).resolves.toBeUndefined();
  });
});

describe('user isolation', () => {
  it('stores identical text for two users and never returns the other users vectors', async () => {
    const alice = user();
    const bob = user();
    await Promise.all([save(alice, 'alice-doc', [1, 0]), save(bob, 'bob-doc', [1, 0])]);

    const engine = new VectorRetrievalEngine(store);
    expect(await engine.retrieveTopK(alice, [1, 0])).toEqual([{ id: 'alice-doc', score: 1, vector: [1, 0] }]);
    expect(await engine.retrieveTopK(bob, [1, 0])).toEqual([{ id: 'bob-doc', score: 1, vector: [1, 0] }]);
    expect(await store.getEmbedding(alice, 'bob-doc')).toBeNull();
    expect(await store.getEmbeddingMetadata(alice, 'bob-doc')).toBeNull();
  });

  it('deletes only the callers own rows even when the session id is shared', async () => {
    const alice = user();
    const bob = user();
    await save(alice, 'shared-id', [1, 0]);
    await save(bob, 'shared-id', [0, 1]);

    await store.deleteEmbedding(alice, 'shared-id');
    expect(await store.getEmbedding(alice, 'shared-id')).toBeNull();
    expect(await store.getEmbedding(bob, 'shared-id')).toEqual([0, 1]);

    await store.clear(alice);
    expect(await store.getEmbedding(bob, 'shared-id')).toEqual([0, 1]);
  });

  it('refuses to retrieve without an owner on either path', async () => {
    const engine = new VectorRetrievalEngine(store);
    await expect(engine.retrieveTopK({ scope: 'user' } as EmbeddingScope, [1, 0])).rejects.toThrow('owner');
    await expect(engine.retrieveTopK(undefined as unknown as EmbeddingScope, [1, 0])).rejects.toThrow('owner');
  });

  it('filters by content type', async () => {
    const alice = user();
    await save(alice, 'bullet', [1, 0], 'resume_bullet');
    await save(alice, 'requirement', [1, 0], 'job_requirement');

    const engine = new VectorRetrievalEngine(store);
    const ids = async (types?: ('resume_bullet' | 'job_requirement')[]) =>
      (await engine.retrieveTopK(alice, [1, 0], 5, { contentTypes: types })).map(hit => hit.id).sort();
    expect(await ids()).toEqual(['bullet', 'requirement']);
    expect(await ids(['job_requirement'])).toEqual(['requirement']);
  });
});

describe('vector search capability and fallback', () => {
  it('falls back to in-process cosine on a plain MongoDB without throwing', async () => {
    const alice = user();
    await save(alice, 'close', [1, 0.1]);
    await save(alice, 'far', [0, 1]);
    await save(user(), 'someone-else', [1, 0.1]);

    expect(await store.supportsNativeVectorSearch('embeddings_vector_idx')).toBe(false);
    const hits = await new VectorRetrievalEngine(store).retrieveTopK(alice, [1, 0], 2);
    expect(hits.map(hit => hit.id)).toEqual(['close', 'far']);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('probes once and reuses the answer until the ttl passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const probe = vi.spyOn(store, 'supportsNativeVectorSearch').mockResolvedValue(false);
    const engine = new VectorRetrievalEngine(store, { capabilityTtlMs: 1000 });
    const alice = user();

    await engine.retrieveTopK(alice, [1, 0]);
    await engine.retrieveTopK(alice, [1, 0]);
    expect(probe).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1001);
    await engine.retrieveTopK(alice, [1, 0]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('uses $vectorSearch when the index is queryable, rescoring with cosine and merging chunks', async () => {
    vi.spyOn(store, 'supportsNativeVectorSearch').mockResolvedValue(true);
    const search = vi.spyOn(store, 'nativeVectorSearch').mockResolvedValue([
      { id: 'resume-a', vector: [1, 0] },
      { id: 'resume-b', vector: [1, 1] },
      { id: 'resume-a', vector: [0, 1] }, // weaker chunk of the same resume
    ]);
    const fallback = vi.spyOn(store, 'getAllEmbeddings');
    const alice = user();

    const hits = await new VectorRetrievalEngine(store, { indexName: 'custom_idx' }).retrieveTopK(alice, [1, 0], 5);
    expect(hits.map(hit => hit.id)).toEqual(['resume-a', 'resume-b']);
    expect(hits[0]).toMatchObject({ score: 1, vector: [1, 0] });
    expect(hits[1].score).toBeCloseTo(Math.SQRT1_2);
    expect(search).toHaveBeenCalledWith(alice, [1, 0], expect.objectContaining({ indexName: 'custom_idx', limit: 20 }));
    expect(fallback).not.toHaveBeenCalled();
  });

  it('applies weightThreshold and k on the native path', async () => {
    vi.spyOn(store, 'supportsNativeVectorSearch').mockResolvedValue(true);
    vi.spyOn(store, 'nativeVectorSearch').mockResolvedValue([
      { id: 'a', vector: [1, 0] }, { id: 'b', vector: [1, 1] }, { id: 'c', vector: [0, 1] },
    ]);
    const engine = new VectorRetrievalEngine(store);
    expect((await engine.retrieveTopK(user(), [1, 0], 5, { weightThreshold: 0.5 })).map(hit => hit.id)).toEqual(['a', 'b']);
    expect((await engine.retrieveTopK(user(), [1, 0], 1)).map(hit => hit.id)).toEqual(['a']);
  });

  it('answers from cosine and re-probes when the native query fails', async () => {
    const probe = vi.spyOn(store, 'supportsNativeVectorSearch').mockResolvedValue(true);
    vi.spyOn(store, 'nativeVectorSearch').mockRejectedValue(new Error('index is not ready'));
    const alice = user();
    await save(alice, 'mine', [1, 0]);

    const engine = new VectorRetrievalEngine(store);
    expect(await engine.retrieveTopK(alice, [1, 0])).toEqual([{ id: 'mine', score: 1, vector: [1, 0] }]);
    await engine.retrieveTopK(alice, [1, 0]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('builds an owner scoped pipeline and asserts the owner again after the search', () => {
    const owner = user() as { scope: 'user'; userId: string };
    const [search, match] = buildVectorSearchPipeline(owner, [1, 0, 0], {
      indexName: 'idx', limit: 5, contentTypes: ['job_requirement'],
    });
    const ownerId = new Types.ObjectId(owner.userId);
    expect(search.$vectorSearch).toMatchObject({
      index: 'idx', path: 'vector', limit: 5, numCandidates: 100,
      filter: { scope: 'user', userId: ownerId, dimensions: 3, contentType: { $in: ['job_requirement'] } },
    });
    expect(match).toEqual({ $match: { scope: 'user', userId: ownerId, dimensions: 3 } });

    const [shared] = buildVectorSearchPipeline(globalScope, [1, 0], { indexName: 'idx', limit: 5 });
    expect(shared.$vectorSearch?.filter).toEqual({ scope: 'global', dimensions: 2 });
    expect(() => buildVectorSearchPipeline({ scope: 'user' } as EmbeddingScope, [1], { indexName: 'idx', limit: 1 }))
      .toThrow('owner');
  });
});

describe('cascade delete with the parent resume', () => {
  const session = (sessionId: string, userId: string) => ({
    sessionId,
    userId,
    currentStage: 'UPLOADED',
    uploadMetadata: {
      originalFilename: 'cv.pdf', fileType: 'pdf', fileSize: 1, mimeType: 'application/pdf',
      uploadPath: '/tmp/cv.pdf', uploadedAt: new Date(),
    },
    parsedContent: { text: 'cv' },
    timestamps: { uploadedAt: new Date(), lastUpdated: new Date() },
  });

  async function seed() {
    const alice = user() as { scope: 'user'; userId: string };
    const bob = user() as { scope: 'user'; userId: string };
    // Session IDs are unique per session, but embedding keys are only unique per owner: bob has his own 's1' rows.
    await ResumeSession.create([session('s1', alice.userId), session('s2', alice.userId), session('b1', bob.userId)]);
    for (const id of ['s1', 's2']) await save(alice, id, [1, 0]);
    await save(bob, 's1', [1, 0]);
    return { alice, bob };
  }

  it('deletes the sessions embeddings with doc.deleteOne()', async () => {
    const { alice, bob } = await seed();
    await (await ResumeSession.findOne({ sessionId: 's1', userId: alice.userId }))!.deleteOne();
    expect(await store.getEmbedding(alice, 's1')).toBeNull();
    expect(await store.getEmbedding(alice, 's2')).toEqual([1, 0]);
    expect(await store.getEmbedding(bob, 's1')).toEqual([1, 0]);
  });

  it('deletes them with Model.deleteOne, findOneAndDelete and deleteMany', async () => {
    let { alice, bob } = await seed();
    await ResumeSession.deleteOne({ sessionId: 's1', userId: alice.userId });
    expect(await store.getEmbedding(alice, 's1')).toBeNull();
    expect(await store.getEmbedding(bob, 's1')).toEqual([1, 0]);
    expect(await store.getEmbedding(alice, 's2')).toEqual([1, 0]);

    await ResumeSession.findOneAndDelete({ sessionId: 's2', userId: alice.userId });
    expect(await store.getEmbedding(alice, 's2')).toBeNull();

    await Promise.all([ResumeSession.collection.deleteMany({}), Embedding.collection.deleteMany({})]);
    ({ alice, bob } = await seed());
    await ResumeSession.deleteMany({ userId: alice.userId });
    expect(await Embedding.countDocuments({ userId: new Types.ObjectId(alice.userId) })).toBe(0);
    expect(await store.getEmbedding(bob, 's1')).toEqual([1, 0]);
  });

  it('leaves embeddings alone when nothing matched the delete', async () => {
    const { alice } = await seed();
    await ResumeSession.deleteOne({ sessionId: 'missing', userId: alice.userId });
    expect(await Embedding.countDocuments()).toBe(3);
  });
});
