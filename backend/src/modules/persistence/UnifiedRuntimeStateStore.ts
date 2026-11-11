import mongoose, { Schema } from 'mongoose';
import { logger } from '../../shared/logger.js';
import { getRedisClient } from '../../shared/redis/index.js';

export interface IRuntimeSnapshot {
  _id: string;
  state: any;
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

export class UnifiedRuntimeStateStore {
  private memoryCache = new Map<string, any>();

  private getRedisKey(id: string): string {
    return `runtime_snapshot:${id}`;
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
    const deepCopied = JSON.parse(JSON.stringify(state));
    this.memoryCache.set(id, deepCopied);

    // 1. Try Redis cache (TTL 7 days)
    try {
      const redis = getRedisClient();
      if (redis.status === 'ready') {
        await redis.set(this.getRedisKey(id), JSON.stringify(deepCopied), 'EX', 7 * 86400);
      }
    } catch (err) {
      logger.warn(`[UnifiedRuntimeStateStore] Failed to write state to Redis for key ${id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Try MongoDB durable persistence
    try {
      if (mongoose.connection.readyState === 1) {
        const metadata = this.parseKeyMetadata(id, deepCopied);
        await RuntimeSnapshot.updateOne(
          { _id: id },
          {
            $set: {
              _id: id,
              state: deepCopied,
              userId: metadata.userId,
              stateType: metadata.stateType,
              timestamp: metadata.timestamp,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
      }
    } catch (err) {
      logger.warn(`[UnifiedRuntimeStateStore] Failed to write state to MongoDB for key ${id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getState(id: string): Promise<any> {
    // 1. Try Redis
    try {
      const redis = getRedisClient();
      if (redis.status === 'ready') {
        const cached = await redis.get(this.getRedisKey(id));
        if (cached !== null && cached !== undefined) {
          const parsed = JSON.parse(cached);
          this.memoryCache.set(id, parsed);
          return parsed;
        }
      }
    } catch (err) {
      logger.warn(`[UnifiedRuntimeStateStore] Failed to read state from Redis for key ${id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Try MongoDB
    try {
      if (mongoose.connection.readyState === 1) {
        const doc = (await RuntimeSnapshot.findOne({ _id: id }).lean()) as IRuntimeSnapshot | null;
        if (doc && doc.state !== undefined) {
          this.memoryCache.set(id, doc.state);
          try {
            const redis = getRedisClient();
            if (redis.status === 'ready') {
              await redis.set(this.getRedisKey(id), JSON.stringify(doc.state), 'EX', 7 * 86400);
            }
          } catch {
            // Ignore Redis backfill failures
          }
          return JSON.parse(JSON.stringify(doc.state));
        }
      }
    } catch (err) {
      logger.warn(`[UnifiedRuntimeStateStore] Failed to read state from MongoDB for key ${id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Fallback to process-local memory cache
    const memoryState = this.memoryCache.get(id);
    return memoryState ? JSON.parse(JSON.stringify(memoryState)) : null;
  }

  async querySnapshots(filter: ISnapshotQueryFilter): Promise<any[]> {
    // 1. Query MongoDB if connected
    if (mongoose.connection.readyState === 1) {
      try {
        const query: any = {};
        if (filter.userId) query.userId = filter.userId;
        if (filter.stateType) query.stateType = filter.stateType;
        if (filter.fromDate || filter.toDate) {
          query.timestamp = {};
          if (filter.fromDate) query.timestamp.$gte = filter.fromDate;
          if (filter.toDate) query.timestamp.$lte = filter.toDate;
        }
        const docs = (await RuntimeSnapshot.find(query).sort({ timestamp: 1 }).lean()) as IRuntimeSnapshot[];
        if (docs.length > 0) {
          return docs.map((d) => d.state);
        }
      } catch (err) {
        logger.warn('[UnifiedRuntimeStateStore] Failed to query snapshots from MongoDB', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2. Fallback to memory cache
    const results: any[] = [];
    for (const [key, state] of this.memoryCache.entries()) {
      const meta = this.parseKeyMetadata(key, state);
      if (filter.userId && meta.userId !== filter.userId) continue;
      if (filter.stateType && meta.stateType !== filter.stateType) continue;
      if (filter.fromDate && meta.timestamp && meta.timestamp < filter.fromDate) continue;
      if (filter.toDate && meta.timestamp && meta.timestamp > filter.toDate) continue;
      results.push(JSON.parse(JSON.stringify(state)));
    }
    return results;
  }
}
