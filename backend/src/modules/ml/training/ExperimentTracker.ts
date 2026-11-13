// src/modules/ml/training/ExperimentTracker.ts
// Tracks ML experiments: hyperparameters, metrics, artifacts, comparisons.

import { randomUUID } from 'node:crypto';
import { Error as MongooseError } from 'mongoose';
import { MLExperimentModel } from '../../../db/models/mlExperiment.model.js';
import { logger } from '../../../shared/logger.js';
import type { ExperimentRecord, TrainingRun, EvaluationMetrics } from '../types.js';

/**
 * ExperimentTracker
 *
 * Tracks and compares ML experiments:
 * - Hyperparameter configurations
 * - Training metrics over time
 * - Run comparisons
 * - Best model selection
 */
export class ExperimentTracker {
  private static readonly maxWriteAttempts = 5;

  constructor() {
    logger.info('[ExperimentTracker] Initialized');
  }

  /**
   * Create a new experiment.
   */
  async createExperiment(name: string, description: string): Promise<ExperimentRecord> {
    const experimentId = `exp-${randomUUID()}`;
    const now = new Date().toISOString();
    const record: ExperimentRecord = {
      experimentId,
      name,
      description,
      runs: [],
      bestRunId: null,
      createdAt: now,
      updatedAt: now,
    };

    await MLExperimentModel.create(record);
    logger.info(`[ExperimentTracker] Created experiment ${experimentId}: ${name}`);
    return record;
  }

  /**
   * Log a training run to an experiment.
   */
  async logRun(experimentId: string, run: TrainingRun): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const experiment = await MLExperimentModel.findOne({ experimentId });
      if (!experiment) {
        logger.warn(`[ExperimentTracker] Experiment ${experimentId} not found`);
        return;
      }

      const runIndex = experiment.runs.findIndex(existing => existing.runId === run.runId);
      if (runIndex === -1) {
        experiment.runs.push(run);
      } else {
        const existing = experiment.runs[runIndex];
        // Ignore late progress updates and retries after a run reaches a terminal state.
        if (existing.status !== 'running') return;
        experiment.runs[runIndex] = run;
      }

      experiment.updatedAt = new Date().toISOString();
      experiment.bestRunId = this.selectBestRunId(experiment.runs);

      try {
        // The version check makes the run and best-run changes one atomic write.
        await experiment.save();
        break;
      } catch (error) {
        if (!(error instanceof MongooseError.VersionError) || attempt >= ExperimentTracker.maxWriteAttempts) {
          throw error;
        }
      }
    }

    logger.info(`[ExperimentTracker] Logged run ${run.runId} to experiment ${experimentId}`);
  }

  /**
   * Compare runs within an experiment.
   */
  async compareRuns(experimentId: string, metricName: keyof EvaluationMetrics): Promise<{
    runId: string;
    value: number;
    rank: number;
    config: Record<string, number | string | boolean>;
  }[]> {
    const experiment = await this.getExperiment(experimentId);
    if (!experiment) return [];

    const completedRuns = experiment.runs.filter(r => r.status === 'completed');
    const values = completedRuns
      .map(run => ({
        runId: run.runId,
        value: (run.metrics[metricName] as number) ?? 0,
        config: run.config.hyperparameters,
      }))
      .sort((a, b) => b.value - a.value);

    return values.map((v, i) => ({ ...v, rank: i + 1 }));
  }

  /**
   * Get the best run for an experiment.
   */
  async getBestRun(experimentId: string): Promise<TrainingRun | null> {
    const experiment = await this.getExperiment(experimentId);
    if (!experiment || !experiment.bestRunId) return null;
    return experiment.runs.find(r => r.runId === experiment.bestRunId) ?? null;
  }

  /**
   * Get experiment details.
   */
  async getExperiment(experimentId: string): Promise<ExperimentRecord | undefined> {
    const experiment = await MLExperimentModel.findOne({ experimentId }, { _id: 0, __v: 0 }).lean();
    return experiment ?? undefined;
  }

  /**
   * List all experiments.
   */
  async listExperiments(): Promise<ExperimentRecord[]> {
    return MLExperimentModel.find({}, { _id: 0, __v: 0 }).sort({ createdAt: 1, _id: 1 }).lean();
  }

  /**
   * Get summary statistics for an experiment.
   */
  async getSummary(experimentId: string): Promise<{
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    bestMetrics: EvaluationMetrics | null;
    metricProgression: { runId: string; metrics: EvaluationMetrics }[];
  } | null> {
    const experiment = await this.getExperiment(experimentId);
    if (!experiment) return null;

    const completed = experiment.runs.filter(r => r.status === 'completed');
    const failed = experiment.runs.filter(r => r.status === 'failed');
    const bestRun = completed.find(run => run.runId === experiment.bestRunId);

    return {
      totalRuns: experiment.runs.length,
      completedRuns: completed.length,
      failedRuns: failed.length,
      bestMetrics: bestRun?.metrics ?? null,
      metricProgression: completed.map(r => ({ runId: r.runId, metrics: r.metrics })),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private selectBestRunId(runs: TrainingRun[]): string | null {
    const completed = runs.filter(r => r.status === 'completed');
    if (completed.length === 0) return null;

    // Select best by primary metric (NDCG > F1 > accuracy > AUC)
    let bestRun = completed[0];
    let bestScore = this.primaryMetric(bestRun.metrics);

    for (const run of completed.slice(1)) {
      const score = this.primaryMetric(run.metrics);
      if (score > bestScore) {
        bestScore = score;
        bestRun = run;
      }
    }

    return bestRun.runId;
  }

  private primaryMetric(metrics: EvaluationMetrics): number {
    return metrics.ndcg ?? metrics.f1 ?? metrics.accuracy ?? metrics.auc ?? 0;
  }
}
