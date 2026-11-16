import { Schema } from 'mongoose';

export const schemaMigrationSchema = new Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  checksum: { type: String, required: true },
  batch: { type: Number, required: true },
  appliedAt: { type: Date, default: null },
  executionTimeMs: { type: Number, required: true },
  status: { type: String, enum: ['success', 'failed', 'rolled_back'], required: true },
  recovery: { type: String, enum: ['up', 'down'] },
}, { collection: 'schema_migrations', versionKey: false });