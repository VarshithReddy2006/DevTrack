import type { mongo } from 'mongoose';
import { LEAGUE_STANDING_INDEXES } from '../models/leagueStandingIndexes.js';

const standingsCollection = 'leaguestandings';
const settingsCollection = 'usersettings';

// Weekly leagues are opt-in. Mongoose applies the default to new documents only, so write the
// explicit `false` onto existing settings documents.
export async function migrateLeagues(db: mongo.Db): Promise<void> {
  const standings = db.collection(standingsCollection);
  for (const { key, options } of LEAGUE_STANDING_INDEXES) {
    await standings.createIndex(key, options);
  }
  await db
    .collection(settingsCollection)
    .updateMany({ 'leagues.participate': { $exists: false } }, { $set: { 'leagues.participate': false } });
}

export async function rollbackLeagues(db: mongo.Db): Promise<void> {
  const standings = db.collection(standingsCollection);
  for (const { options } of LEAGUE_STANDING_INDEXES) {
    try {
      await standings.dropIndex(options.name);
    } catch (error) {
      // 26 = namespace not found, 27 = index not found: already rolled back.
      const code = (error as { code?: number }).code;
      if (code !== 26 && code !== 27) throw error;
    }
  }
  // Only the opt-in flag is removed. LeagueStanding rows are history and are kept.
  await db.collection(settingsCollection).updateMany({ leagues: { $exists: true } }, { $unset: { leagues: '' } });
}
