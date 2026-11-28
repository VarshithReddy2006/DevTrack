import mongoose from 'mongoose';
import { expect, it } from 'vitest';
import { discoverMigrations } from '../../../db/migrations/discover.js';

it('creates and removes the one-assignment-per-user-and-day index', async () => {
  const migration = (await discoverMigrations()).find(m => m.name.endsWith('-dailyChallengeAssignments'))!;
  // A separate disposable database, so model auto-indexing cannot create the index first.
  const db = mongoose.connection.getClient().db('challenge_assignment_migration_test');
  try {
    await migration.up({ db });
    await migration.up({ db });
    const assignments = db.collection('dailychallengeassignments');
    const userId = new mongoose.Types.ObjectId();
    await assignments.insertOne({ userId, dayKey: '2026-10-28', difficulty: 'easy' });
    await assignments.insertOne({ userId, dayKey: '2026-10-29', difficulty: 'easy' });
    await expect(assignments.insertOne({ userId, dayKey: '2026-10-28', difficulty: 'hard' }))
      .rejects.toMatchObject({ code: 11000 });

    await migration.down({ db });
    await migration.down({ db });
    expect((await assignments.listIndexes().toArray()).map(index => index.name)).toEqual(['_id_']);
    expect(await assignments.countDocuments({})).toBe(2);
  } finally {
    await db.dropDatabase();
  }
});
