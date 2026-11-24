const ARCHIVE_COLLECTION = 'dsa_submissions_archive';
const COMPOUND_INDEX_KEY = { userId: 1, createdAt: -1 };
const COMPOUND_INDEX_NAME = 'idx_dsa_submissions_archive_userId_createdAt';

export const name = '20261123000000-partitionSubmissions';

export async function up({ db, session }) {
  // Create the cold archive collection with WiredTiger collection-level compression so
  // historical records occupy less RAM and disk than the hot collection.
  const collections = await db.listCollections({ name: ARCHIVE_COLLECTION }, { session }).toArray();
  if (collections.length === 0) {
    try {
      await db.createCollection(ARCHIVE_COLLECTION, {
        storageEngine: {
          wiredTiger: { configString: 'block_compressor=zstd' },
        },
      });
    } catch {
      // MongoDB Atlas shared/serverless clusters disallow custom storageEngine parameter
      await db.createCollection(ARCHIVE_COLLECTION);
    }
  }

  const archive = db.collection(ARCHIVE_COLLECTION);
  const existing = await archive.indexes({ session });
  const hasCompound = existing.some(
    (index) =>
      Object.entries(index.key ?? {}).length === 2 &&
      Object.entries(index.key ?? {}).every(
        ([field, direction], i) =>
          field === Object.keys(COMPOUND_INDEX_KEY)[i] && direction === Object.values(COMPOUND_INDEX_KEY)[i]
      ) &&
      !index.unique &&
      !index.sparse &&
      !index.hidden &&
      index.expireAfterSeconds == null
  );
  if (!hasCompound) {
    await archive.createIndex(COMPOUND_INDEX_KEY, {
      name: COMPOUND_INDEX_NAME,
      background: true,
      session,
    });
  }
}

export async function down({ db, session }) {
  const archive = db.collection(ARCHIVE_COLLECTION);
  try {
    await archive.dropIndex(COMPOUND_INDEX_NAME, { session });
  } catch (error) {
    const code = error?.code;
    // 26 = namespace not found, 27 = index not found: already rolled back.
    if (code !== 26 && code !== 27) throw error;
  }
  try {
    await db.dropCollection(ARCHIVE_COLLECTION, { session });
  } catch (error) {
    const code = error?.code;
    if (code !== 26) throw error;
  }
}

export default {
  name,
  up,
  down,
};
