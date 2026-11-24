import type { mongo } from 'mongoose';
import { INTERVIEW_GUARD_INDEXES, INTERVIEW_SESSION_INDEXES } from '../models/interviewSessionIndexes.js';

const sessionsCollection = 'interviewsessions';
const indexes = [...INTERVIEW_SESSION_INDEXES, ...INTERVIEW_GUARD_INDEXES];

// Creates the collection (if needed) and its indexes. The unique partial index on
// { userId, isOpen } is what enforces one open interview per user. Production runs with
// Mongoose autoIndex off, so this migration is how the indexes get there.
export async function migrateInterviewSessions(db: mongo.Db): Promise<void> {
  const sessions = db.collection(sessionsCollection);
  for (const { key, options } of indexes) {
    await sessions.createIndex(key, options);
  }
}

export async function rollbackInterviewSessions(db: mongo.Db): Promise<void> {
  const sessions = db.collection(sessionsCollection);
  for (const { options } of indexes) {
    try {
      await sessions.dropIndex(options.name);
    } catch (error) {
      // 26 = namespace not found, 27 = index not found: already rolled back.
      const code = (error as { code?: number }).code;
      if (code !== 26 && code !== 27) throw error;
    }
  }
  // Only indexes are removed. Interview sessions hold candidate answers and are kept.
}
