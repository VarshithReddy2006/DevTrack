import { describe, expect, it, vi } from 'vitest';
import { MLModelBaselineModel } from '../../../../db/models/mlBaseline.model.js';
import { FineTuningInfrastructure } from '../FineTuningInfrastructure.js';

const config = {
  modelType: 'ranker' as const,
  baseModelId: 'ranker',
  datasetId: 'sample',
  learningRate: 0.01,
  epochs: 2,
  batchSize: 1,
  warmupSteps: 0,
  weightDecay: 0,
};

const samples = [{ features: [0.5], label: 1 }];

describe('FineTuningInfrastructure persistence', () => {
  it('recovers a versioned baseline and persists run history and loss curves', async () => {
    const writer = new FineTuningInfrastructure();
    await writer.registerBaseline('ranker', { ndcg: 0.1 });
    await writer.registerBaseline('ranker', { ndcg: 0.25 }, 'v2');
    await writer.registerBaseline('ranker', { ndcg: 0.5, precisionAtK: { 5: 0.4 } }, 'v2');

    const worker = new FineTuningInfrastructure();
    expect(await worker.getBaselines()).toEqual(new Map([['ranker', { ndcg: 0.1 }]]));
    const result = await worker.fineTune(
      { ...config, baseModelVersion: 'v2' },
      samples,
      samples,
      vi.fn().mockResolvedValueOnce(0.75).mockResolvedValueOnce(0.5),
      vi.fn()
        .mockResolvedValueOnce({ logloss: 0.5 })
        .mockResolvedValueOnce({ logloss: 0.25 })
        .mockResolvedValueOnce({ ndcg: 0.75 }),
    );

    expect(result).toMatchObject({
      baseModelVersion: 'v2',
      baselineMetrics: { ndcg: 0.5, precisionAtK: { 5: 0.4 } },
      fineTunedMetrics: { ndcg: 0.75 },
      improvement: { ndcg: 0.25 },
      totalSteps: 2,
      trainingLoss: [0.75, 0.5],
      validationLoss: [0.5, 0.25],
    });
    const reader = new FineTuningInfrastructure();
    expect(await reader.getRun(result.runId)).toEqual(result);
    expect(await reader.getHistory()).toEqual([result]);
    expect(reader.isImproved(result)).toBe(true);
  });

  it('keeps one baseline per model and version when workers register concurrently', async () => {
    const first = new FineTuningInfrastructure();
    const second = new FineTuningInfrastructure();
    await Promise.all([
      first.registerBaseline('ranker', { ndcg: 0.4 }, 'v2'),
      second.registerBaseline('ranker', { ndcg: 0.5 }, 'v2'),
    ]);
    expect(await MLModelBaselineModel.countDocuments({ modelId: 'ranker', version: 'v2' })).toBe(1);
  });

  it('requires the requested baseline version before running training', async () => {
    const tracker = new FineTuningInfrastructure();
    await tracker.registerBaseline('ranker', { ndcg: 0.5 });
    const train = vi.fn();
    const evaluate = vi.fn();
    await expect(tracker.fineTune({ ...config, baseModelVersion: 'v2' }, samples, samples, train, evaluate))
      .rejects.toThrow('No baseline exists for model ranker (version v2)');
    expect(train).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(await tracker.getHistory()).toEqual([]);
    expect(await tracker.getRun('unknown')).toBeNull();
  });
});
