import mongoose from 'mongoose';
import { migrateInterviewSessions, rollbackInterviewSessions } from './0015-interview-sessions.js';

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Set MONGODB_URI explicitly before running this migration');

const [direction = 'up', ...extra] = process.argv.slice(2);
if (extra.length || (direction !== 'up' && direction !== 'down')) throw new Error('Expected up or down');

try {
  await mongoose.connect(uri, { autoIndex: false });
  const db = mongoose.connection.db!;
  await (direction === 'up' ? migrateInterviewSessions(db) : rollbackInterviewSessions(db));
  console.log(`Interview sessions migration ${direction} complete`);
} finally {
  await mongoose.disconnect();
}
