import { Schema, model } from 'mongoose';
import type { SnapshotData, SnapshotMetadata } from '../../modules/operations/SnapshotVersioningSystem.js';

const metadataSchema = new Schema<SnapshotMetadata>({
  snapshotId: { type: String, required: true },
  userId: { type: String, required: true },
  snapshotVersion: { type: String, required: true },
  analyticsVersion: { type: String, required: true },
  graphVersion: { type: String, required: true },
  scoringVersion: { type: String, required: true },
  createdAt: { type: Date, required: true },
  createdBy: { type: String, required: true },
  parentSnapshotId: String,
  changeDescription: String,
  modelType: { type: String, required: true },
}, { _id: false });

const schema = new Schema<SnapshotData>({
  metadata: { type: metadataSchema, required: true },
  data: Schema.Types.Mixed,
}, { minimize: false, versionKey: false });

schema.index({ 'metadata.snapshotId': 1 }, { unique: true });
schema.index({ 'metadata.userId': 1, 'metadata.modelType': 1, 'metadata.createdAt': -1, _id: -1 });
schema.index({ 'metadata.userId': 1, 'metadata.createdAt': -1, _id: -1 });
schema.index({ 'metadata.parentSnapshotId': 1 });
schema.index({ 'metadata.createdAt': 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export const ReadinessSnapshotRecord = model<SnapshotData>('ReadinessSnapshotRecord', schema);

const versionSchema = new Schema<{ _id: string; version: number }>({
  _id: String,
  version: { type: Number, required: true },
}, { versionKey: false });

export const ReadinessSnapshotVersion = model('ReadinessSnapshotVersion', versionSchema);
