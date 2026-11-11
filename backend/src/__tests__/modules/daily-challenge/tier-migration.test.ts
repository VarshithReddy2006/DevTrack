import mongoose from 'mongoose';
import { expect, it } from 'vitest';
import { migrateDailyChallengeTiers } from '../../../db/migrations/daily-challenge-tiers.js';

it('replaces legacy uniqueness idempotently without changing existing challenges or XP', async () => {
  // A separate disposable database prevents model auto-indexing from racing the
  // legacy index fixture; no configured database or application data is touched.
  const db = mongoose.connection.getClient().db('challenge_tier_migration_test');
  try {
    const challenges = db.collection('dailychallenges');
    await challenges.createIndex({ date: 1 }, { unique: true });
    const legacy = { date: '2026-11-10', difficulty: 'easy', title: 'Legacy', completionCount: 12 };
    const { insertedId } = await challenges.insertOne(legacy);
    const ledger = db.collection('xptransactions');
    await ledger.insertOne({ sourceId: insertedId.toString(), xpAwarded: 30 });
    await migrateDailyChallengeTiers(db);
    await migrateDailyChallengeTiers(db);
    expect(await challenges.findOne({ _id: insertedId })).toEqual({ _id: insertedId, ...legacy });
    await challenges.insertOne({ date: legacy.date, difficulty: 'hard' });
    await expect(challenges.insertOne({ date: legacy.date, difficulty: 'easy' })).rejects.toMatchObject({ code: 11000 });
    expect(await ledger.findOne({ sourceId: insertedId.toString() })).toMatchObject({ xpAwarded: 30 });
    expect((await challenges.listIndexes().toArray()).map(index => index.name)).toEqual(['_id_', 'date_1_difficulty_1']);
  } finally {
    await db.dropDatabase();
  }
});
