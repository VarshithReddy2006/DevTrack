import mongoose from 'mongoose';
import { migrateDailyChallengeTiers } from './daily-challenge-tiers.js';

// Intentionally no .env loading or localhost fallback: the operator must choose
// the database explicitly. No model imports or automatic index synchronization.
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Set MONGODB_URI explicitly before running this migration');
try {
  await mongoose.connect(uri, { autoIndex: false });
  await migrateDailyChallengeTiers(mongoose.connection.db!);
  console.log('Daily challenge date/difficulty index migration complete');
} finally {
  await mongoose.disconnect();
}
