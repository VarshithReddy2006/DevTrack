import { randomUUID } from 'node:crypto';
import { ReadinessSnapshotRecord, ReadinessSnapshotVersion } from '../../db/models/readinessSnapshotRecord.model.js';

export interface SnapshotMetadata {
  snapshotId: string;
  userId: string;
  snapshotVersion: string;
  analyticsVersion: string;
  graphVersion: string;
  scoringVersion: string;
  createdAt: Date;
  createdBy: string; // 'system' or user ID
  parentSnapshotId?: string;
  changeDescription: string;
  modelType: 'dsa' | 'skills' | 'projects' | 'roadmap' | 'benchmarks' | 'core';
}

export interface SnapshotData {
  metadata: SnapshotMetadata;
  data: any; // The actual readiness model data
}

export interface VersionLineage {
  snapshotId: string;
  version: string;
  parentSnapshotId?: string;
  childSnapshotIds: string[];
  createdAt: Date;
  changeDescription: string;
}

const versionCounterId = 'snapshots';
const newestFirst = { 'metadata.createdAt': -1, _id: -1 } as const;
const recordFields = { _id: 0, metadata: 1, data: 1 };

interface SnapshotQuery {
  modelType?: SnapshotMetadata['modelType'];
  since?: Date;
  limit?: number;
}

export class SnapshotVersioningSystemClass {
  async createSnapshot(
    userId: string,
    modelType: SnapshotMetadata['modelType'],
    data: unknown,
    changeDescription: string,
    parentSnapshotId?: string,
    createdBy = 'system',
  ): Promise<SnapshotMetadata> {
    const counter = await ReadinessSnapshotVersion.findByIdAndUpdate(
      versionCounterId, { $inc: { version: 1 } }, { upsert: true, new: true },
    ).lean();
    const metadata: SnapshotMetadata = {
      snapshotId: randomUUID(),
      userId,
      snapshotVersion: `1.0.${counter.version}`,
      analyticsVersion: '1.0.0',
      graphVersion: '1.0.0',
      scoringVersion: '1.0.0',
      createdAt: new Date(),
      createdBy,
      parentSnapshotId,
      changeDescription,
      modelType,
    };

    await ReadinessSnapshotRecord.create({ metadata, data });
    return metadata;
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotData | undefined> {
    return (await ReadinessSnapshotRecord.findOne({ 'metadata.snapshotId': snapshotId }, recordFields).lean()) ?? undefined;
  }

  async getLatestSnapshot(userId: string, modelType: SnapshotMetadata['modelType']): Promise<SnapshotData | undefined> {
    return (await this.getUserSnapshots(userId, { modelType, limit: 1 }))[0];
  }

  async getUserSnapshots(userId: string, { modelType, since, limit }: SnapshotQuery = {}): Promise<SnapshotData[]> {
    const query = ReadinessSnapshotRecord.find({
      'metadata.userId': userId,
      ...(modelType && { 'metadata.modelType': modelType }),
      ...(since && { 'metadata.createdAt': { $gte: since } }),
    }, recordFields).sort(newestFirst);
    if (limit !== undefined) query.limit(limit);
    return query.lean();
  }

  async getLineage(snapshotId: string): Promise<VersionLineage | undefined> {
    const snapshot = await ReadinessSnapshotRecord.findOne(
      { 'metadata.snapshotId': snapshotId }, { metadata: 1 },
    ).lean();
    if (!snapshot) return undefined;

    const { userId, snapshotVersion, parentSnapshotId, createdAt, changeDescription } = snapshot.metadata;
    const children = await ReadinessSnapshotRecord.find(
      { 'metadata.parentSnapshotId': snapshotId, 'metadata.userId': userId },
      { 'metadata.snapshotId': 1 },
    ).sort({ 'metadata.createdAt': 1, _id: 1 }).lean();

    return {
      snapshotId,
      version: snapshotVersion,
      parentSnapshotId,
      childSnapshotIds: children.map(child => child.metadata.snapshotId),
      createdAt,
      changeDescription,
    };
  }

  async getVersionHistory(snapshotId: string): Promise<VersionLineage[]> {
    const history: VersionLineage[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = snapshotId;
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const lineage = await this.getLineage(currentId);
      if (!lineage) break;
      history.push(lineage);
      currentId = lineage.parentSnapshotId;
    }
    return history;
  }

  async rollbackToSnapshot(snapshotId: string): Promise<SnapshotData | undefined> {
    return this.getSnapshot(snapshotId);
  }

  async deleteOldSnapshots(userId: string, keepCount = 10): Promise<number> {
    const query = ReadinessSnapshotRecord.find({ 'metadata.userId': userId }, { _id: 1 }).sort(newestFirst);
    const outdated = await query.skip(Math.max(0, Math.trunc(keepCount))).lean();
    const result = await ReadinessSnapshotRecord.deleteMany({ _id: { $in: outdated.map(snapshot => snapshot._id) } });
    return result.deletedCount;
  }

  async getStats(): Promise<{
    totalSnapshots: number;
    totalLineageEntries: number;
    currentVersion: string;
    snapshotsByModelType: Record<string, number>;
  }> {
    const [counts, counter] = await Promise.all([
      ReadinessSnapshotRecord.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$metadata.modelType', count: { $sum: 1 } } },
      ]),
      ReadinessSnapshotVersion.findById(versionCounterId).lean(),
    ]);
    const totalSnapshots = counts.reduce((sum, { count }) => sum + count, 0);
    return {
      totalSnapshots,
      totalLineageEntries: totalSnapshots,
      currentVersion: `1.0.${counter?.version ?? 0}`,
      snapshotsByModelType: Object.fromEntries(counts.map(({ _id, count }) => [_id, count])),
    };
  }
}

export const SnapshotVersioningSystem = new SnapshotVersioningSystemClass();
