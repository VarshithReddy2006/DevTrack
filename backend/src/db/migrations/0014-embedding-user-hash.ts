import type { mongo } from 'mongoose';
import { EMBEDDING_USER_HASH_INDEX, LEGACY_EMBEDDING_HASH_INDEX } from '../models/embeddingIndexes.js';

const embeddingsCollection = 'embeddings';

// 26 = namespace not found, 27 = index not found: nothing left to drop.
async function dropIndexIfPresent(collection: mongo.Collection, name: string): Promise<void> {
  try {
    await collection.dropIndex(name);
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code !== 26 && code !== 27) throw error;
  }
}

/**
 * Swaps the global unique index on contentHash for a per-owner one. The new index is built
 * first so uniqueness is never missing. Anything unique on contentHash alone is also unique
 * on (userId, contentHash), so existing data cannot violate it.
 */
export async function migrateEmbeddingUserHash(db: mongo.Db): Promise<void> {
  const embeddings = db.collection(embeddingsCollection);
  await embeddings.createIndex(EMBEDDING_USER_HASH_INDEX.key, EMBEDDING_USER_HASH_INDEX.options);
  await dropIndexIfPresent(embeddings, LEGACY_EMBEDDING_HASH_INDEX.options.name);
}

/**
 * Restores the global unique index. This fails with a duplicate key error if two owners now
 * share a contentHash; that is deliberate, no embeddings are deleted to make it pass.
 */
export async function rollbackEmbeddingUserHash(db: mongo.Db): Promise<void> {
  const embeddings = db.collection(embeddingsCollection);
  await embeddings.createIndex(LEGACY_EMBEDDING_HASH_INDEX.key, LEGACY_EMBEDDING_HASH_INDEX.options);
  await dropIndexIfPresent(embeddings, EMBEDDING_USER_HASH_INDEX.options.name);
}
