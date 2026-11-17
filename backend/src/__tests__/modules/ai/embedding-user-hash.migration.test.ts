import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  migrateEmbeddingUserHash,
  rollbackEmbeddingUserHash,
} from '../../../db/migrations/0014-embedding-user-hash.js';
import { Embedding } from '../../../db/models/embedding.model.js';

const row = (userId: Types.ObjectId, contentHash: string) => ({
  sessionId: 's', chunkIndex: 0, scope: 'user', userId, vector: [1], dimensions: 1, provider: 'openai',
  providerModel: 'm', content: 'c', contentHash, contentType: 'resume', embeddingVersion: '1.0.0', generatedAt: new Date(),
});

describe('0014-embedding-user-hash migration', () => {
  it('moves a legacy collection to the per-user index and back, twice over', async () => {
    const db = mongoose.connection.db!;
    const embeddings = db.collection('embeddings');
    await Embedding.init(); // let Mongoose finish building the schema's own indexes first
    await rollbackEmbeddingUserHash(db); // legacy shape: global unique contentHash only
    const names = async () => (await embeddings.indexes()).map(index => index.name);
    expect(await names()).toContain('contentHash_1');
    expect(await names()).not.toContain('uq_embeddings_user_hash');

    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    await embeddings.insertOne(row(alice, 'h1'));
    await expect(embeddings.insertOne(row(bob, 'h1'))).rejects.toMatchObject({ code: 11000 });

    await migrateEmbeddingUserHash(db);
    await migrateEmbeddingUserHash(db); // safe to run twice
    expect(await names()).toContain('uq_embeddings_user_hash');
    expect(await names()).not.toContain('contentHash_1');
    await expect(embeddings.insertOne(row(bob, 'h1'))).resolves.toBeDefined();
    await expect(embeddings.insertOne(row(bob, 'h1'))).rejects.toMatchObject({ code: 11000 });
    expect(await embeddings.countDocuments({ contentHash: 'h1' })).toBe(2);

    // Two owners share a hash now, so restoring the global index must fail and keep the data.
    await expect(rollbackEmbeddingUserHash(db)).rejects.toMatchObject({ code: 11000 });
    expect(await embeddings.countDocuments({ contentHash: 'h1' })).toBe(2);
    expect(await names()).toContain('uq_embeddings_user_hash');

    await embeddings.deleteOne({ userId: bob });
    await rollbackEmbeddingUserHash(db);
    await rollbackEmbeddingUserHash(db);
    expect(await names()).toContain('contentHash_1');
    expect(await names()).not.toContain('uq_embeddings_user_hash');

    await migrateEmbeddingUserHash(db); // leave the collection in the schema's shape
  });
});
