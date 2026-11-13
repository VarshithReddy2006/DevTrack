// src/modules/ml/fine-tuning/FineTuningInfrastructure.ts
// Fine-tuning pipelines for DistilBERT, semantic classifiers, ranking, recommendations.
// Fine-tuning ONLY after evaluation baselines exist.

import { randomUUID } from 'node:crypto';
import { FineTuneRunModel } from '../../../db/models/fineTuneRun.model.js';
import { MLModelBaselineModel } from '../../../db/models/mlBaseline.model.js';
import { logger } from '../../../shared/logger.js';
import type { EvaluationMetrics, TrainingSample } from '../types.js';

const defaultBaselineVersion = 'default';

interface FineTuneConfig {
  modelType: 'distilbert' | 'classifier' | 'ranker' | 'recommender';
  baseModelId: string;
  baseModelVersion?: string;
  datasetId: string;
  learningRate: number;
  epochs: number;
  batchSize: number;
  warmupSteps: number;
  weightDecay: number;
  freezeLayers?: number[];
}

export interface FineTuneResult {
  runId: string;
  modelType: string;
  baseModelId: string;
  baseModelVersion: string;
  baselineMetrics: EvaluationMetrics;
  fineTunedMetrics: EvaluationMetrics;
  improvement: Record<string, number>;
  epochs: number;
  totalSteps: number;
  trainingLoss: number[];
  validationLoss: number[];
  timestamp: string;
}

/**
 * FineTuningInfrastructure
 *
 * Supports fine-tuning for:
 * - DistilBERT encoder (domain-specific language)
 * - Semantic classifiers (task-specific heads)
 * - Ranking models (feedback-based optimization)
 * - Recommendation models (outcome-based optimization)
 *
 * GOVERNANCE: Fine-tuning ONLY after evaluation baselines exist.
 * Every fine-tuning run must compare against baseline metrics.
 */
export class FineTuningInfrastructure {
  constructor() {
    logger.info('[FineTuningInfrastructure] Initialized');
  }

  /**
   * Register a baseline for a model (required before fine-tuning).
   */
  async registerBaseline(
    modelId: string,
    metrics: EvaluationMetrics,
    version = defaultBaselineVersion,
  ): Promise<void> {
    await MLModelBaselineModel.init();
    await MLModelBaselineModel.updateOne(
      { modelId, version },
      { $set: { metrics } },
      { upsert: true, runValidators: true },
    );
    logger.info(`[FineTuningInfrastructure] Baseline registered for ${modelId}`, { metrics });
  }

  /**
   * Execute a fine-tuning run.
   * GOVERNANCE: Requires baseline to exist.
   */
  async fineTune(
    config: FineTuneConfig,
    trainData: TrainingSample[],
    valData: TrainingSample[],
    trainStepFn: (batch: TrainingSample[], lr: number) => Promise<number>,
    evalFn: (data: TrainingSample[]) => Promise<EvaluationMetrics>,
  ): Promise<FineTuneResult> {
    const baseModelVersion = config.baseModelVersion ?? defaultBaselineVersion;
    const baselineRecord = await MLModelBaselineModel.findOne({
      modelId: config.baseModelId,
      version: baseModelVersion,
    }).lean();
    const baseline = baselineRecord?.metrics;
    if (!baseline) {
      throw new Error(
        `No baseline exists for model ${config.baseModelId} (version ${baseModelVersion}). ` +
        'Register baseline metrics before fine-tuning.',
      );
    }

    const runId = `ft-${randomUUID()}`;
    logger.info(`[FineTuningInfrastructure] Starting fine-tune run ${runId} for ${config.modelType}`);

    const trainingLoss: number[] = [];
    const validationLoss: number[] = [];
    let totalSteps = 0;

    // Training loop
    for (let epoch = 0; epoch < config.epochs; epoch++) {
      const batches = this.createBatches(trainData, config.batchSize);
      let epochLoss = 0;

      // Learning rate warmup + decay
      const epochLR = this.computeLearningRate(
        config.learningRate,
        epoch,
        config.epochs,
        config.warmupSteps,
        totalSteps,
      );

      for (const batch of batches) {
        const loss = await trainStepFn(batch, epochLR);
        epochLoss += loss;
        totalSteps++;
      }

      const averageLoss = batches.length === 0 ? 0 : epochLoss / batches.length;
      trainingLoss.push(averageLoss);

      // Validation
      const valMetrics = await evalFn(valData);
      const valLoss = valMetrics.logloss ?? valMetrics.mae ?? 0;
      validationLoss.push(valLoss);

      logger.info(`[FineTuningInfrastructure] Epoch ${epoch}: train_loss=${averageLoss.toFixed(4)}, val_loss=${valLoss.toFixed(4)}`);
    }

    // Final evaluation
    const fineTunedMetrics = await evalFn(valData);

    // Compute improvement over baseline
    const improvement: Record<string, number> = {};
    for (const [key, baselineValue] of Object.entries(baseline)) {
      const fineTunedValue = (fineTunedMetrics as Record<string, unknown>)[key];
      if (typeof baselineValue === 'number' && typeof fineTunedValue === 'number') {
        improvement[key] = fineTunedValue - baselineValue;
      }
    }

    const result: FineTuneResult = {
      runId,
      modelType: config.modelType,
      baseModelId: config.baseModelId,
      baseModelVersion,
      baselineMetrics: baseline,
      fineTunedMetrics,
      improvement,
      epochs: config.epochs,
      totalSteps,
      trainingLoss,
      validationLoss,
      timestamp: new Date().toISOString(),
    };

    await FineTuneRunModel.create(result);
    logger.info(`[FineTuningInfrastructure] Fine-tune ${runId} complete`, { improvement });

    return result;
  }

  /**
   * Check if fine-tuning improved over baseline.
   */
  isImproved(result: FineTuneResult, primaryMetric: keyof EvaluationMetrics = 'ndcg'): boolean {
    const imp = result.improvement[primaryMetric];
    return typeof imp === 'number' && imp > 0;
  }

  /**
   * Get fine-tuning history.
   */
  async getHistory(): Promise<FineTuneResult[]> {
    return FineTuneRunModel.find({}, { _id: 0, __v: 0 }).sort({ timestamp: 1, _id: 1 }).lean();
  }

  async getRun(runId: string): Promise<FineTuneResult | null> {
    return FineTuneRunModel.findOne({ runId }, { _id: 0, __v: 0 }).lean();
  }

  /**
   * Get baselines.
   */
  async getBaselines(version = defaultBaselineVersion): Promise<Map<string, EvaluationMetrics>> {
    const records = await MLModelBaselineModel.find({ version }).lean();
    return new Map(records.map(({ modelId, metrics }) => [modelId, metrics]));
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private createBatches(data: TrainingSample[], batchSize: number): TrainingSample[][] {
    const batches: TrainingSample[][] = [];
    for (let i = 0; i < data.length; i += batchSize) {
      batches.push(data.slice(i, i + batchSize));
    }
    return batches;
  }

  private computeLearningRate(
    baseLR: number,
    epoch: number,
    totalEpochs: number,
    warmupSteps: number,
    currentStep: number,
  ): number {
    // Linear warmup
    if (currentStep < warmupSteps) {
      return baseLR * (currentStep / warmupSteps);
    }

    // Cosine decay
    const progress = epoch / totalEpochs;
    return baseLR * 0.5 * (1 + Math.cos(Math.PI * progress));
  }
}
