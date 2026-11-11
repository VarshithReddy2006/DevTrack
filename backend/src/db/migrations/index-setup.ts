import mongoose from 'mongoose';
import { logger } from '../../shared/logger.js';
import { ResumeSession } from '../models/resumeSession.model.js';
import { DatasetIngestionState } from '../models/datasetIngestion.model.js';
import { ActivityEvent } from '../models/activityEvent.model.js';

/**
 * Setup production optimized database indexes.
 * Enforces compound indexes for rapid query processing.
 */
export async function setupProductionIndexes(): Promise<void> {
  logger.info('[DatabaseMigration] Setting up optimized production indexes...');

  try {
    // 1. Optimized queries for resume session retrievals (userId + sessionId)
    const resumeColl = ResumeSession.collection;
    logger.info(`[DatabaseMigration] Registering compound index on ${resumeColl.collectionName} (userId, sessionId)`);
    await safelyCreateIndex(
      resumeColl,
      { userId: 1, sessionId: 1 },
      { name: 'idx_userId_sessionId', background: true }
    );

    // 2. High-speed lookup for ingestion monitoring
    const datasetColl = DatasetIngestionState.collection;
    logger.info(`[DatabaseMigration] Registering index on ${datasetColl.collectionName} (status)`);
    await safelyCreateIndex(
      datasetColl,
      { status: 1 },
      { name: 'idx_ingestion_status', background: true }
    );

    // 3. Fast indexing of activity telemetry
    const activityColl = ActivityEvent.collection;
    logger.info(`[DatabaseMigration] Registering compound index on ${activityColl.collectionName} (userId, createdAt)`);
    await safelyCreateIndex(
      activityColl,
      { userId: 1, createdAt: -1 },
      { name: 'idx_userId_createdAt', background: true }
    );

    logger.info('[DatabaseMigration] Production optimized indexes successfully registered.');
  } catch (error) {
    logger.error('[DatabaseMigration] Failed to setup production indexes', error);
    // Do not crash the gateway if indexing encountered a network timeout
  }
}

async function safelyCreateIndex(
  collection: mongoose.Collection,
  spec: Record<string, 1 | -1>,
  options: mongoose.mongo.CreateIndexesOptions
): Promise<void> {
  try {
    const existing = await collection.indexes().catch(() => []);
    const specKeys = Object.keys(spec);
    const isExisting = existing.some((idx) => {
      if (options.name && idx.name === options.name) return true;
      const idxKeys = Object.keys(idx.key || {});
      if (idxKeys.length === specKeys.length && specKeys.every((k) => (idx.key as any)?.[k] === spec[k])) {
        return true;
      }
      return false;
    });

    if (!isExisting) {
      await collection.createIndex(spec, options);
    }
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === 'IndexOptionsConflict') {
      logger.warn(`[DatabaseMigration] Index already exists with conflicting options on ${collection.collectionName}`, { spec, options });
    } else {
      throw err;
    }
  }
}
