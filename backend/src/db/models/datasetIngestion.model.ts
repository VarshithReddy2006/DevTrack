// src/db/models/datasetIngestion.model.ts
import { Schema, model, type Document } from 'mongoose';

export interface IDatasetIngestionState extends Document {
  datasetId: string;
  sourceFilePath: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  rowsProcessed: number;
  rowsFailed: number;
  rowsNormalized: number;
  duplicatesSkipped: number;
  embeddingsGenerated: number;
  lastCheckpointIndex: number;
  sourceVersion?: string;
  attemptId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const datasetIngestionStateSchema = new Schema<IDatasetIngestionState>(
  {
    datasetId: {
      type: String,
      required: true,
    },
    sourceFilePath: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
      index: true,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    errorMessage: {
      type: String,
      default: null,
    },
    rowsProcessed: {
      type: Number,
      default: 0,
    },
    rowsFailed: {
      type: Number,
      default: 0,
    },
    rowsNormalized: {
      type: Number,
      default: 0,
    },
    duplicatesSkipped: {
      type: Number,
      default: 0,
    },
    embeddingsGenerated: {
      type: Number,
      default: 0,
    },
    lastCheckpointIndex: {
      type: Number,
      default: 0,
    },
    sourceVersion: String,
    attemptId: String,
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete (ret as { _id?: unknown })._id;
        delete (ret as { __v?: unknown }).__v;
        return ret;
      },
    },
  }
);

// Indexes
datasetIngestionStateSchema.index({ datasetId: 1 }, { unique: true, name: 'unique_dataset_ingestion_id' });
datasetIngestionStateSchema.index({ datasetId: 1, status: 1 });
datasetIngestionStateSchema.index({ startedAt: -1 });

export const DatasetIngestionState = model<IDatasetIngestionState>('DatasetIngestionState', datasetIngestionStateSchema);

export const DatasetIngestedRow = model('DatasetIngestedRow', new Schema({
  _id: { type: String, required: true },
  datasetId: { type: String, required: true, index: true },
  firstRowIndex: { type: Number, required: true },
  data: { type: Schema.Types.Mixed, required: true },
}));
