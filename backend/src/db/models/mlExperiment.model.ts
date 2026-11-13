import { Schema, model } from 'mongoose';
import type { ExperimentRecord, TrainingRun } from '../../modules/ml/types.js';

const trainingRunSchema = new Schema<TrainingRun>({
  runId: { type: String, required: true },
  experimentId: { type: String, required: true },
  modelId: { type: String, required: true },
  config: { type: Schema.Types.Mixed, required: true },
  metrics: { type: Schema.Types.Mixed, required: true },
  startedAt: { type: String, required: true },
  completedAt: { type: String, default: null },
  status: { type: String, enum: ['running', 'completed', 'failed', 'cancelled'], required: true },
  checkpoints: [String],
}, { _id: false, minimize: false });

const mlExperimentSchema = new Schema<ExperimentRecord>({
  experimentId: { type: String, required: true, unique: true },
  name: { type: String, required: true, index: true },
  description: { type: String, default: '' },
  runs: [trainingRunSchema],
  bestRunId: { type: String, default: null, index: true },
  createdAt: { type: String, required: true, index: true },
  updatedAt: { type: String, required: true },
}, { optimisticConcurrency: true, minimize: false });

export const MLExperimentModel = model('MLExperiment', mlExperimentSchema);
