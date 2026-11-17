import mongoose from 'mongoose';
import { migratePublicProfileOptIn, rollbackPublicProfileOptIn } from './0013-public-profile-opt-in.js';

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Set MONGODB_URI explicitly before running this migration');

const [direction = 'up', ...extra] = process.argv.slice(2);
if (extra.length || (direction !== 'up' && direction !== 'down')) throw new Error('Expected up or down');

try {
  await mongoose.connect(uri, { autoIndex: false });
  const db = mongoose.connection.db!;
  await (direction === 'up' ? migratePublicProfileOptIn(db) : rollbackPublicProfileOptIn(db));
  console.log(`Public profile opt-in migration ${direction} complete`);
} finally {
  await mongoose.disconnect();
}
