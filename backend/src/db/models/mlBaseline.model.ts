import { Schema, model } from 'mongoose';
import type { EvaluationMetrics } from '../../modules/ml/types.js';

interface MLModelBaseline {
  modelId: string;
  version: string;
  metrics: EvaluationMetrics;
}

const baselineSchema = new Schema<MLModelBaseline>({
  modelId: { type: String, required: true },
  version: { type: String, required: true },
  metrics: { type: Schema.Types.Mixed, required: true },
}, { minimize: false });

baselineSchema.index({ modelId: 1, version: 1 }, { unique: true });

export const MLModelBaselineModel = model('MLModelBaseline', baselineSchema);
