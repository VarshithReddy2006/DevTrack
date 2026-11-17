// Index definitions shared by the Embedding model and the embedding index migration,
// so the schema and the migrated collection cannot drift apart.
export const EMBEDDING_USER_HASH_INDEX = {
  // Unique per owner, not globally: two users can embed the same bullet point.
  key: { userId: 1, contentHash: 1 } as const,
  options: { name: 'uq_embeddings_user_hash', unique: true } as const,
};

// The old global unique index that made a second user's identical content fail with E11000.
export const LEGACY_EMBEDDING_HASH_INDEX = {
  key: { contentHash: 1 } as const,
  options: { name: 'contentHash_1', unique: true } as const,
};
