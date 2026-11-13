import { describe, expect, it } from 'vitest';
import { MLExperimentModel } from '../../../db/models/mlExperiment.model.js';
import type { TrainingRun } from '../types.js';
import { ExperimentTracker } from './ExperimentTracker.js';

function trainingRun(
  experimentId: string,
  runId: string,
  ndcg: number,
  status: TrainingRun['status'] = 'completed',
): TrainingRun {
  return {
    experimentId,
    runId,
    modelId: 'ranker',
    config: {
      datasetId: 'sample',
      modelType: 'ranker',
      hyperparameters: { learningRate: 0.1, optimizer: '$adam', shuffle: true },
      validationSplit: 0.2,
      maxEpochs: 5,
      earlyStoppingPatience: 2,
      checkpointInterval: 1,
      seed: 42,
    },
    metrics: status === 'completed' ? { ndcg, precisionAtK: { 5: 0.4 } } : {},
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: status === 'running' ? null : '2026-01-01T00:01:00.000Z',
    status,
    checkpoints: ['checkpoint-1'],
  };
}

describe('ExperimentTracker persistence', () => {
  it('reads experiment history, comparisons and summaries through a fresh tracker', async () => {
    const writer = new ExperimentTracker();
    const experiment = await writer.createExperiment('Ranking', 'Compare ranking runs');
    const { experimentId } = experiment;
    const lower = trainingRun(experimentId, 'lower', 0.4);
    const higher = trainingRun(experimentId, 'higher', 0.8);
    const failed = trainingRun(experimentId, 'failed', 0, 'failed');
    for (const run of [lower, higher, failed]) await writer.logRun(experimentId, run);

    const reader = new ExperimentTracker();
    expect(await reader.getExperiment(experimentId)).toEqual({
      ...experiment,
      runs: [lower, higher, failed],
      bestRunId: higher.runId,
      updatedAt: expect.any(String),
    });
    expect(await reader.listExperiments()).toEqual([await reader.getExperiment(experimentId)]);
    expect(await reader.getBestRun(experimentId)).toEqual(higher);
    expect(await reader.compareRuns(experimentId, 'ndcg')).toEqual([
      { runId: 'higher', value: 0.8, rank: 1, config: higher.config.hyperparameters },
      { runId: 'lower', value: 0.4, rank: 2, config: lower.config.hyperparameters },
    ]);
    expect(await reader.getSummary(experimentId)).toEqual({
      totalRuns: 3,
      completedRuns: 2,
      failedRuns: 1,
      bestMetrics: higher.metrics,
      metricProgression: [lower, higher].map(({ runId, metrics }) => ({ runId, metrics })),
    });
  });

  it('preserves concurrent writes and records one terminal result per run', async () => {
    const first = new ExperimentTracker();
    const second = new ExperimentTracker();
    const { experimentId } = await first.createExperiment('Concurrent runs', '');
    const running = trainingRun(experimentId, 'higher', 0, 'running');
    const higher = trainingRun(experimentId, 'higher', 0.9);
    const lower = trainingRun(experimentId, 'lower', 0.2);

    await first.logRun(experimentId, running);
    expect(await second.getBestRun(experimentId)).toBeNull();
    await Promise.all([first.logRun(experimentId, higher), second.logRun(experimentId, lower)]);
    await second.logRun(experimentId, running);
    await second.logRun(experimentId, higher);

    const stored = await MLExperimentModel.findOne({ experimentId }).lean();
    expect(stored?.bestRunId).toBe(higher.runId);
    expect(stored?.runs).toHaveLength(2);
    expect(stored?.runs).toEqual(expect.arrayContaining([higher, lower]));
  });

  it('keeps the existing results for an unknown experiment', async () => {
    const tracker = new ExperimentTracker();
    expect(await tracker.getExperiment('missing')).toBeUndefined();
    expect(await tracker.getBestRun('missing')).toBeNull();
    expect(await tracker.getSummary('missing')).toBeNull();
    expect(await tracker.compareRuns('missing', 'ndcg')).toEqual([]);
    await tracker.logRun('missing', trainingRun('missing', 'run', 0.9));
    expect(await tracker.listExperiments()).toEqual([]);
  });
});
