import mongoose from 'mongoose';
import { logger } from '../../shared/logger.js';
import { ResumeSession } from '../models/resumeSession.model.js';
import { DatasetIngestionState } from '../models/datasetIngestion.model.js';
import { ActivityEvent } from '../models/activityEvent.model.js';

// Indexes added outside the schemas. The index auditor treats them as expected, not orphaned.
export const PRODUCTION_INDEXES: ReadonlyArray<{ model: mongoose.Model<any>; key: IndexKey; name: string }> = [
  { model: ResumeSession, key: { userId: 1, sessionId: 1 }, name: 'idx_userId_sessionId' },
  { model: DatasetIngestionState, key: { status: 1 }, name: 'idx_ingestion_status' },
  { model: ActivityEvent, key: { userId: 1, createdAt: -1 }, name: 'idx_userId_createdAt' },
];

export async function setupProductionIndexes(): Promise<void> {
  for (const { model: { collection }, key, name } of PRODUCTION_INDEXES) {
    try {
      await ensureIndex(collection, key, name);
    } catch (error) {
      // An indexing failure must not prevent startup or the other index checks.
      logger.error('[DatabaseMigration] Failed to register production index', { collection: collection.collectionName, key, error });
    }
  }
}

type IndexKey = Record<string, 1 | -1>;
type ExistingIndex = Awaited<ReturnType<mongoose.Collection['indexes']>>[number];

function matchesIndex(index: ExistingIndex, key: IndexKey): boolean {
  const actual = Object.entries(index.key ?? {});
  const expected = Object.entries(key);
  return actual.length === expected.length
    && expected.every(([field, direction], position) => actual[position][0] === field && actual[position][1] === direction)
    && !index.hidden && !index.sparse && !index.unique
    && index.partialFilterExpression == null && index.expireAfterSeconds == null
    && (index.collation == null || index.collation.locale === 'simple');
}

async function ensureIndex(collection: mongoose.Collection, key: IndexKey, name: string): Promise<void> {
  const existing = await collection.indexes().catch((error: { code?: number }) => {
    if (error.code === 26) return []; // Collection does not exist yet.
    throw error;
  });
  if (existing.some(index => matchesIndex(index, key))) return;

  // Preserve an existing index with the preferred name if it serves another query.
  const availableName = existing.some(index => index.name === name) ? `${name}_v2` : name;
  try {
    await collection.createIndex(key, { name: availableName, background: true });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if ((code === 85 || code === 86) && (await collection.indexes()).some(index => matchesIndex(index, key))) return;
    throw error;
  }
}
