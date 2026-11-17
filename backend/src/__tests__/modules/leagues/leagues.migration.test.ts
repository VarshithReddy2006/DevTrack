import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { migrateLeagues, rollbackLeagues } from '../../../db/migrations/0012-leagues.js';
import { LEAGUE_STANDING_INDEXES } from '../../../db/models/leagueStandingIndexes.js';
import { LeagueStanding } from '../../../db/models/index.js';

describe('0012-leagues migration', () => {
  it('creates the standing indexes, backfills the opt-in flag and rolls back cleanly', async () => {
    const db = mongoose.connection.db!;
    const settings = db.collection('usersettings');
    const standings = db.collection('leaguestandings');
    await LeagueStanding.createCollection();
    await rollbackLeagues(db);

    const legacy = await settings.insertOne({ userId: new mongoose.Types.ObjectId(), appearance: { theme: 'dark' } });
    const optedIn = await settings.insertOne({ userId: new mongoose.Types.ObjectId(), leagues: { participate: true } });

    await migrateLeagues(db);
    await migrateLeagues(db); // safe to run twice

    const indexNames = (await standings.indexes()).map(index => index.name);
    for (const { options } of LEAGUE_STANDING_INDEXES) expect(indexNames).toContain(options.name);
    const unique = (await standings.indexes()).find(index => index.name === 'uq_leaguestandings_week_user');
    expect(unique).toMatchObject({ key: { weekKey: 1, userId: 1 }, unique: true });

    expect(await settings.findOne({ _id: legacy.insertedId })).toMatchObject({ leagues: { participate: false }, appearance: { theme: 'dark' } });
    expect(await settings.findOne({ _id: optedIn.insertedId })).toMatchObject({ leagues: { participate: true } }); // never overwritten

    await rollbackLeagues(db);
    await rollbackLeagues(db); // and twice
    const after = (await standings.indexes()).map(index => index.name);
    for (const { options } of LEAGUE_STANDING_INDEXES) expect(after).not.toContain(options.name);
    expect(await settings.findOne({ _id: legacy.insertedId })).not.toHaveProperty('leagues');
  });

  it('rolls back on a database that never ran the migration', async () => {
    await expect(rollbackLeagues(mongoose.connection.db!)).resolves.toBeUndefined();
  });
});
