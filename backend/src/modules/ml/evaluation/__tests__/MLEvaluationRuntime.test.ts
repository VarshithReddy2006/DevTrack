import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { MLEvaluationRuntime } from '../MLEvaluationRuntime.js';

const runtime = new MLEvaluationRuntime();

describe('MLEvaluationRuntime', () => {
  it('rejects classification length mismatches and invalid labels', async () => {
    await expect(runtime.evaluateClassification({ predicted: [1, 0], actual: [1] }))
      .rejects.toThrow('must have the same length (got 2 and 1)');
    await expect(runtime.evaluateClassification({ predicted: [1, 2], actual: [1, 0] }))
      .rejects.toThrow('labels must be 0 or 1 (index 1)');
  });

  it('rejects invalid ranking cutoffs and query inputs', async () => {
    await expect(runtime.evaluateRanking([], [0])).rejects.toThrow('cutoffs must be positive integers');
    const sparseQueries = new Array<{ predicted: string[]; relevant: Set<string> }>(1);
    await expect(runtime.evaluateRanking(sparseQueries)).rejects.toThrow('Ranking query 0');
  });

  it('keeps ranking metric values and query order', async () => {
    const queries = [
      { predicted: ['a', 'b', 'c'], relevant: new Set(['b', 'c', 'unretrieved']) },
      { predicted: ['d', 'e'], relevant: new Set(['d']) },
    ];
    const { metrics, perQueryMetrics } = await runtime.evaluateRanking(queries, [1, 3]);
    expect(metrics.ndcg).toBeCloseTo(queries.reduce((sum, query) =>
      sum + runtime.ndcgAtK(query.predicted, query.relevant, 10), 0) / queries.length);
    expect(metrics.mrr).toBe(0.75);
    expect(metrics.precisionAtK).toEqual({ 1: 0.5, 3: 0.5 });
    expect(metrics.recallAtK).toEqual({ 1: 0.5, 3: (2 / 3 + 1) / 2 });
    expect(perQueryMetrics?.map(query => query.queryId)).toEqual(['query_0', 'query_1']);
  });

  it('returns finite zero metrics for empty inputs and queries with no relevant items', async () => {
    const zeroRanking = { ndcg: 0, mrr: 0, precisionAtK: { 1: 0 }, recallAtK: { 1: 0 } };
    expect((await runtime.evaluateRanking([], [1])).metrics).toEqual(zeroRanking);
    expect((await runtime.evaluateRanking([{ predicted: ['a'], relevant: new Set() }], [1])).metrics)
      .toEqual(zeroRanking);
    expect((await runtime.evaluateClassification({ predicted: [], actual: [] })).metrics)
      .toEqual({ f1: 0, accuracy: 0 });
    expect((await runtime.evaluateClassification({ predicted: [0], actual: [0] })).metrics)
      .toEqual({ f1: 0, accuracy: 1 });
  });

  it('yields during large classification runs and aggregates counts across batches', async () => {
    const predicted = Array.from({ length: 20_001 }, (_, index) => index < 500 ? 1 : 0);
    const actual = Array.from({ length: 20_001 }, (_, index) => index < 1_000 ? 1 : 0);
    let finished = false;
    const evaluation = runtime.evaluateClassification({ predicted, actual }).then(report => {
      finished = true;
      return report;
    });

    await setImmediate();
    expect(finished).toBe(false);
    const { metrics } = await evaluation;
    expect(metrics.f1).toBeCloseTo(2 / 3);
    expect(metrics.accuracy).toBeCloseTo(19_501 / 20_001);
  });

  it('yields within a single large ranking query', async () => {
    const predicted = Array.from({ length: 20_001 }, (_, index) => String(index));
    let finished = false;
    const evaluation = runtime.evaluateRanking([{ predicted, relevant: new Set(['20000']) }]).then(report => {
      finished = true;
      return report;
    });

    await setImmediate();
    expect(finished).toBe(false);
    expect((await evaluation).metrics.mrr).toBe(1 / 20_001);
  });

  it('rejects a timed-out evaluation and allows another evaluation afterward', async () => {
    const values = Array<number>(20_001).fill(1);
    await expect(runtime.evaluateClassification({ predicted: values, actual: values }, { timeoutMs: 0.0001 }))
      .rejects.toThrow('ML evaluation timed out after 0.0001 ms');
    await expect(runtime.evaluateRanking([], [1], { timeoutMs: Infinity })).rejects.toThrow('positive finite number');
    await expect(runtime.evaluateClassification({ predicted: [1], actual: [1] }))
      .resolves.toMatchObject({ metrics: { f1: 1, accuracy: 1 } });
  });
});
