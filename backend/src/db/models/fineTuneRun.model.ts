import { Schema, model } from 'mongoose';
import type { FineTuneResult } from '../../modules/ml/fine-tuning/FineTuningInfrastructure.js';

const fineTuneRunSchema = new Schema<FineTuneResult>({
  runId: { type: String, required: true, unique: true },
  modelType: { type: String, required: true },
  baseModelId: { type: String, required: true },
  baseModelVersion: { type: String, required: true },
  baselineMetrics: { type: Schema.Types.Mixed, required: true },
  fineTunedMetrics: { type: Schema.Types.Mixed, required: true },
  improvement: { type: Schema.Types.Mixed, required: true },
  epochs: { type: Number, required: true },
  totalSteps: { type: Number, required: true },
  trainingLoss: [Number],
  validationLoss: [Number],
  timestamp: { type: String, required: true, index: true },
}, { minimize: false });

export const FineTuneRunModel = model('FineTuneRun', fineTuneRunSchema);
