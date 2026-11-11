import { randomUUID } from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import { logger } from '../../shared/logger.js';
import { getRedisClient } from '../../shared/redis/index.js';

export interface IRuntimeSnapshot {
  _id: string;
  state: any;
  revision?: string;
  userId?: string;
  stateType?: string;
  timestamp?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const runtimeSnapshotSchema = new Schema<IRuntimeSnapshot>(
  {
    _id: { type: String, required: true },
    state: { type: Schema.Types.Mixed, required: true },
    revision: String,
    userId: { type: String, index: true },
    stateType: { type: String, index: true },
    timestamp: { type: Date, index: true },
  },
  {
    timestamps: true,
    _id: false,
    collection: 'runtimesnapshots',
  }
);

runtimeSnapshotSchema.index({ userId: 1, stateType: 1, timestamp: 1 });

export const RuntimeSnapshot =
  (mongoose.models.RuntimeSnapshot as mongoose.Model<IRuntimeSnapshot>) ||
  mongoose.model<IRuntimeSnapshot>('RuntimeSnapshot', runtimeSnapshotSchema);

export interface ISnapshotQueryFilter {
  userId?: string;
  stateType?: string;
  fromDate?: Date;
  toDate?: Date;
}

const redisTimeoutMs = 500;
const redisTtlSeconds = 7 * 86400;

async function cacheCommand<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Replay cache command timed out')), redisTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class UnifiedRuntimeStateStore {
  private getRedisKey(revision: string): string {
    return `runtime_snapshot:v2:${revision}`;
  }

  private parseKeyMetadata(id: string, state: any): { userId?: string; stateType?: string; timestamp?: Date } {
    let userId = state?.userId ? String(state.userId) : undefined;
    let stateType = state?.stateType ? String(state.stateType) : undefined;
    let timestamp = state?.timestamp ? new Date(state.timestamp) : undefined;

    const parts = id.split(':');
    if (parts[0] === 'intelligence' && parts.length >= 4) {
      userId = userId || parts[1];
      stateType = stateType || parts[2];
      const parsedTime = Number(parts[3]);
      if (!isNaN(parsedTime)) {
        timestamp = timestamp || new Date(parsedTime);
      }
    }

    return { userId, stateType, timestamp: timestamp || new Date() };
  }

  async saveState(id: string, state: any): Promise<void> {
    this.requireDatabase();
    const deepCopied = JSON.parse(JSON.stringify(state));
    const { userId, stateType, timestamp } = this.parseKeyMetadata(id, deepCopied);
    const result = await RuntimeSnapshot.updateOne(
      { _id: id },
      { $set: { state: deepCopied, revision: randomUUID(), userId: userId ?? null, stateType: stateType ?? null, timestamp } },
      { upsert: true, writeConcern: { w: 'majority', j: true } }
    );
    if (!result.acknowledged) throw new Error('Snapshot write was not acknowledged');
  }

  async getState(id: string): Promise<any> {
    this.requireDatabase();
    const redis = this.getReadyCache();
    if (!redis) {
      const doc = await RuntimeSnapshot.findById(id).read('primary').lean();
      return doc ? doc.state : null;
    }
    const metadata = await RuntimeSnapshot.findById(id).select('revision').read('primary').lean();
    if (!metadata) return null;

    // MongoDB chooses the revision. A delayed cache fill for a previous revision
    // cannot overwrite or be read as the newly committed snapshot.
    if (metadata.revision && redis.status === 'ready') {
      try {
        const cached = await cacheCommand(redis.get(this.getRedisKey(metadata.revision)));
        if (cached != null) return JSON.parse(cached);
      } catch (error) {
        logger.warn('[UnifiedRuntimeStateStore] Redis snapshot read failed', { error });
      }
    }

    const doc = await RuntimeSnapshot.findById(id).read('primary').lean();
    if (!doc) return null;
    if (doc.revision && redis.status === 'ready') {
      try {
        await cacheCommand(redis.set(this.getRedisKey(doc.revision), JSON.stringify(doc.state), 'EX', redisTtlSeconds));
      } catch (error) {
        logger.warn('[UnifiedRuntimeStateStore] Redis snapshot fill failed', { error });
      }
    }
    return doc.state;
  }

  async querySnapshots(filter: ISnapshotQueryFilter): Promise<any[]> {
    this.requireDatabase();
    const query: mongoose.FilterQuery<IRuntimeSnapshot> = {};
    if (filter.userId) query.userId = filter.userId;
    if (filter.stateType) query.stateType = filter.stateType;
    if (filter.fromDate || filter.toDate) {
      query.timestamp = {
        ...(filter.fromDate && { $gte: filter.fromDate }),
        ...(filter.toDate && { $lte: filter.toDate }),
      };
    }
    const docs = await RuntimeSnapshot.find(query).sort({ timestamp: 1, _id: 1 }).read('primary').lean();
    return docs.map(doc => doc.state);
  }

  private requireDatabase(): void {
    if (mongoose.connection.readyState !== 1) throw new Error('Snapshot storage requires a connected MongoDB');
  }

  private getReadyCache(): ReturnType<typeof getRedisClient> | undefined {
    try {
      const redis = getRedisClient();
      return redis.status === 'ready' ? redis : undefined;
    } catch (error) {
      logger.warn('[UnifiedRuntimeStateStore] Redis snapshot cache unavailable', { error });
      return undefined;
    }
  }
}
