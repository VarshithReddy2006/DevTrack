import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { setupProductionIndexes } from '../../db/migrations/index-setup.js';
import { ResumeSession } from '../../db/models/resumeSession.model.js';
import { DatasetIngestionState } from '../../db/models/datasetIngestion.model.js';
import { ActivityEvent } from '../../db/models/activityEvent.model.js';

describe('Production Index Setup Migration', () => {
  it('registers indexes on actual Mongoose model collections and avoids ghost collections', async () => {
    await setupProductionIndexes();

    const db = mongoose.connection.db;
    expect(db).toBeDefined();

    // 1. Verify indexes on real collections
    const resumeIndexes = await ResumeSession.collection.indexes();
    const hasResumeIndex = resumeIndexes.some((idx) => idx.name === 'idx_userId_sessionId');
    expect(hasResumeIndex).toBe(true);

    const datasetIndexes = await DatasetIngestionState.collection.indexes();
    const hasDatasetIndex = datasetIndexes.some((idx) => idx.name === 'idx_ingestion_status' || idx.key?.status === 1);
    expect(hasDatasetIndex).toBe(true);

    const activityIndexes = await ActivityEvent.collection.indexes();
    const hasActivityIndex = activityIndexes.some((idx) => idx.name === 'idx_userId_createdAt');
    expect(hasActivityIndex).toBe(true);

    // 2. Verify zero indexes or tables created on unused ghost collection names
    const collections = await db!.listCollections().toArray();
    const collectionNames = collections.map((c) => c.name);

    expect(collectionNames).not.toContain('resume_sessions');
    expect(collectionNames).not.toContain('dataset_ingestion_states');
    expect(collectionNames).not.toContain('activity_logs');
  });

  it('runs idempotently without throwing errors on subsequent executions', async () => {
    await expect(setupProductionIndexes()).resolves.not.toThrow();
    await expect(setupProductionIndexes()).resolves.not.toThrow();
  });

  it.each(['reversed', 'partial'])('adds the expected index when the preferred name has a %s index', async conflict => {
    const collection = ActivityEvent.collection;
    const name = 'idx_userId_createdAt';
    await setupProductionIndexes();
    await collection.dropIndex(name);
    const expected = { userId: 1, createdAt: -1 };
    const conflicting = conflict === 'reversed' ? { createdAt: -1, userId: 1 } : expected;
    try {
      const options = conflict === 'partial' ? { name, partialFilterExpression: { type: 'fixture' } } : { name };
      await collection.createIndex(conflicting, options);
      await setupProductionIndexes();
      await setupProductionIndexes();
      const indexes = await collection.indexes();
      expect(Object.entries(indexes.find(index => index.name === name)!.key))
        .toEqual(Object.entries(conflicting));
      const corrected = indexes.find(index => index.name === `${name}_v2`)!;
      expect(Object.entries(corrected.key)).toEqual(Object.entries(expected));
      expect(corrected.partialFilterExpression).toBeUndefined();
    } finally {
      for (const index of await collection.indexes()) {
        if (index.name === name || index.name === `${name}_v2`) await collection.dropIndex(index.name);
      }
      await setupProductionIndexes();
    }
  });
});
