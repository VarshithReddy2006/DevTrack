import type { mongo } from 'mongoose';

// Run with challenge writers stopped. Existing documents and their XP source
// IDs remain intact; only the obsolete date-only uniqueness is removed.
export async function migrateDailyChallengeTiers(db: mongo.Db): Promise<void> {
  const collection = db.collection('dailychallenges');
  await collection.createIndex({ date: 1, difficulty: 1 }, { unique: true });
  const indexes = await collection.listIndexes().toArray();
  for (const index of indexes) {
    if (index.unique && Object.keys(index.key).length === 1 && index.key.date === 1 && index.name) {
      await collection.dropIndex(index.name);
    }
  }
}
