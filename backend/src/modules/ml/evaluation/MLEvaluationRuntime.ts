// src/modules/ml/evaluation/MLEvaluationRuntime.ts
// Computes NDCG, MRR, Precision@K, Recall@K, F1, Accuracy.
// No model deployment without evaluation.

import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { logger } from '../../../shared/logger.js';
import type { EvaluationMetrics } from '../types.js';

interface RankingEvalInput {
  predicted: string[];     // ordered predicted items
  relevant: Set<string>;   // ground truth relevant items
}

interface ClassificationEvalInput {
  predicted: number[];     // predicted labels (0/1)
  actual: number[];        // ground truth labels (0/1)
}

export interface EvaluationOptions {
  timeoutMs?: number;
}

const batchSize = 500;
const defaultTimeoutMs = 30_000;

function createDeadline({ timeoutMs = defaultTimeoutMs }: EvaluationOptions): () => void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Evaluation timeoutMs must be a positive finite number');
  }
  const deadline = performance.now() + timeoutMs;
  return () => {
    if (performance.now() >= deadline) {
      throw new Error(`ML evaluation timed out after ${timeoutMs} ms`);
    }
  };
}

interface EvaluationReport {
  metrics: EvaluationMetrics;
  perQueryMetrics?: { queryId: string; metrics: EvaluationMetrics }[];
  summary: string;
  timestamp: string;
}

/**
 * MLEvaluationRuntime
 *
 * Comprehensive ML evaluation infrastructure.
 *
 * Ranking metrics: NDCG, MRR, Precision@K, Recall@K
 * Classification metrics: F1, Accuracy, Precision, Recall
 * Quality assessment: ranking, classification, semantic, recommendation, ATS
 *
 * GOVERNANCE: No model deployment without evaluation.
 */
export class MLEvaluationRuntime {
  constructor() {
    logger.info('[MLEvaluationRuntime] Initialized');
  }

  // ---------------------------------------------------------------------------
  // Ranking Metrics
  // ---------------------------------------------------------------------------

  /**
   * Normalized Discounted Cumulative Gain at K.
   */
  ndcgAtK(predicted: string[], relevant: Set<string>, k: number): number {
    const dcg = this.dcgAtK(predicted, relevant, k);
    const idealOrder = predicted
      .map(id => relevant.has(id) ? 1 : 0)
      .sort((a, b) => b - a);
    const idcg = this.dcgFromRelevance(idealOrder, k);
    return idcg > 0 ? dcg / idcg : 0;
  }

  /**
   * Mean Reciprocal Rank.
   */
  mrr(queries: RankingEvalInput[]): number {
    let totalRR = 0;
    for (const query of queries) {
      for (let i = 0; i < query.predicted.length; i++) {
        if (query.relevant.has(query.predicted[i])) {
          totalRR += 1 / (i + 1);
          break;
        }
      }
    }
    return queries.length > 0 ? totalRR / queries.length : 0;
  }

  /**
   * Precision at K.
   */
  precisionAtK(predicted: string[], relevant: Set<string>, k: number): number {
    const topK = predicted.slice(0, k);
    const hits = topK.filter(id => relevant.has(id)).length;
    return k > 0 ? hits / k : 0;
  }

  /**
   * Recall at K.
   */
  recallAtK(predicted: string[], relevant: Set<string>, k: number): number {
    const topK = predicted.slice(0, k);
    const hits = topK.filter(id => relevant.has(id)).length;
    return relevant.size > 0 ? hits / relevant.size : 0;
  }

  // ---------------------------------------------------------------------------
  // Classification Metrics
  // ---------------------------------------------------------------------------

  /**
   * F1 Score.
   */
  f1Score(predicted: number[], actual: number[]): number {
    const precision = this.precision(predicted, actual);
    const recall = this.recall(predicted, actual);
    return precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;
  }

  /**
   * Accuracy.
   */
  accuracy(predicted: number[], actual: number[]): number {
    if (predicted.length === 0) return 0;
    const correct = predicted.filter((p, i) => p === actual[i]).length;
    return correct / predicted.length;
  }

  /**
   * Precision (positive class).
   */
  precision(predicted: number[], actual: number[]): number {
    const tp = predicted.filter((p, i) => p === 1 && actual[i] === 1).length;
    const fp = predicted.filter((p, i) => p === 1 && actual[i] === 0).length;
    return tp + fp > 0 ? tp / (tp + fp) : 0;
  }

  /**
   * Recall (positive class).
   */
  recall(predicted: number[], actual: number[]): number {
    const tp = predicted.filter((p, i) => p === 1 && actual[i] === 1).length;
    const fn = predicted.filter((p, i) => p === 0 && actual[i] === 1).length;
    return tp + fn > 0 ? tp / (tp + fn) : 0;
  }

  /**
   * AUC-ROC (trapezoidal approximation).
   */
  aucRoc(scores: number[], labels: number[]): number {
    // Sort by score descending
    const sorted = scores
      .map((s, i) => ({ score: s, label: labels[i] }))
      .sort((a, b) => b.score - a.score);

    const totalPositive = labels.filter(l => l === 1).length;
    const totalNegative = labels.length - totalPositive;

    if (totalPositive === 0 || totalNegative === 0) return 0.5;

    let tpCount = 0;
    let fpCount = 0;
    let auc = 0;
    let prevFPR = 0;

    for (const item of sorted) {
      if (item.label === 1) {
        tpCount++;
      } else {
        fpCount++;
        const tpr = tpCount / totalPositive;
        const fpr = fpCount / totalNegative;
        auc += tpr * (fpr - prevFPR); // trapezoidal
        prevFPR = fpr;
      }
    }

    return auc;
  }

  // ---------------------------------------------------------------------------
  // Comprehensive Evaluation
  // ---------------------------------------------------------------------------

  /**
   * Run full ranking evaluation.
   */
  async evaluateRanking(
    queries: RankingEvalInput[],
    kValues: number[] = [1, 3, 5, 10],
    options: EvaluationOptions = {},
  ): Promise<EvaluationReport> {
    const checkDeadline = createDeadline(options);
    if (kValues.some(k => !Number.isSafeInteger(k) || k <= 0)) {
      throw new RangeError('Ranking cutoffs must be positive integers');
    }
    logger.info(`[MLEvaluation] Evaluating ranking with ${queries.length} queries`);

    const cutoffs = [...new Set(kValues)];
    const precisionAtKMap = Object.fromEntries(cutoffs.map(k => [k, 0]));
    const recallAtKMap = Object.fromEntries(cutoffs.map(k => [k, 0]));
    const perQueryMetrics: NonNullable<EvaluationReport['perQueryMetrics']> = [];
    let totalNdcg = 0;
    let totalReciprocalRank = 0;
    let batchItems = 0;

    for (const [index, query] of queries.entries()) {
      if (!Array.isArray(query?.predicted) || !(query.relevant instanceof Set)) {
        throw new TypeError(`Ranking query ${index} requires a predicted array and a relevant set`);
      }
      const { predicted, relevant } = query;
      const hitsAtK = Object.fromEntries(cutoffs.map(k => [k, 0]));
      let hits = 0;
      let dcg = 0;
      let reciprocalRank = 0;

      if (relevant.size > 0) {
        for (let rank = 0; rank < predicted.length; rank++) {
          if (relevant.has(predicted[rank])) {
            hits += 1;
            if (hits === 1) reciprocalRank = 1 / (rank + 1);
            if (rank < 10) dcg += 1 / Math.log2(rank + 2);
            for (const k of cutoffs) {
              if (rank < k) hitsAtK[k] += 1;
            }
          }

          if (++batchItems === batchSize) {
            checkDeadline();
            await setImmediate();
            checkDeadline();
            batchItems = 0;
          }
        }
      }

      // Preserve the existing ideal ordering of retrieved items.
      let idealDcg = 0;
      for (let rank = 0; rank < Math.min(10, hits); rank++) {
        idealDcg += 1 / Math.log2(rank + 2);
      }
      const ndcg = idealDcg > 0 ? dcg / idealDcg : 0;
      totalNdcg += ndcg;
      totalReciprocalRank += reciprocalRank;

      const precisionAtK: Record<number, number> = {};
      const recallAtK: Record<number, number> = {};
      for (const k of cutoffs) {
        precisionAtK[k] = hitsAtK[k] / k;
        recallAtK[k] = relevant.size > 0 ? hitsAtK[k] / relevant.size : 0;
        precisionAtKMap[k] += precisionAtK[k];
        recallAtKMap[k] += recallAtK[k];
      }
      perQueryMetrics.push({ queryId: `query_${index}`, metrics: { ndcg, precisionAtK, recallAtK } });

      if (++batchItems === batchSize) {
        checkDeadline();
        await setImmediate();
        checkDeadline();
        batchItems = 0;
      }
    }

    checkDeadline();
    const queryCount = queries.length || 1;
    for (const k of cutoffs) {
      precisionAtKMap[k] /= queryCount;
      recallAtKMap[k] /= queryCount;
    }
    const ndcg = totalNdcg / queryCount;
    const mrr = totalReciprocalRank / queryCount;

    return {
      metrics: { ndcg, mrr, precisionAtK: precisionAtKMap, recallAtK: recallAtKMap },
      perQueryMetrics,
      summary: `NDCG@10=${ndcg.toFixed(4)}, MRR=${mrr.toFixed(4)}, P@5=${precisionAtKMap[5]?.toFixed(4) ?? 'N/A'}`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Run full binary classification evaluation.
   */
  async evaluateClassification(input: ClassificationEvalInput, options: EvaluationOptions = {}): Promise<EvaluationReport> {
    const { predicted, actual } = input;
    if (predicted.length !== actual.length) {
      throw new RangeError(`Classification predicted and actual arrays must have the same length (got ${predicted.length} and ${actual.length})`);
    }
    const checkDeadline = createDeadline(options);
    logger.info(`[MLEvaluation] Evaluating classification with ${predicted.length} samples`);

    let correct = 0;
    let truePositives = 0;
    let predictedPositives = 0;
    let actualPositives = 0;
    for (let start = 0; start < predicted.length; start += batchSize) {
      const end = Math.min(start + batchSize, predicted.length);
      for (let index = start; index < end; index++) {
        const prediction = predicted[index];
        const label = actual[index];
        if ((prediction !== 0 && prediction !== 1) || (label !== 0 && label !== 1)) {
          throw new RangeError(`Classification labels must be 0 or 1 (index ${index})`);
        }
        if (prediction === label) correct += 1;
        if (prediction === 1) predictedPositives += 1;
        if (label === 1) actualPositives += 1;
        if (prediction === 1 && label === 1) truePositives += 1;
      }

      checkDeadline();
      if (end < predicted.length) {
        await setImmediate();
        checkDeadline();
      }
    }

    checkDeadline();
    const positiveCount = predictedPositives + actualPositives;
    const f1 = positiveCount > 0 ? 2 * truePositives / positiveCount : 0;
    const accuracy = predicted.length > 0 ? correct / predicted.length : 0;
    return {
      metrics: { f1, accuracy },
      summary: `F1=${f1.toFixed(4)}, Accuracy=${accuracy.toFixed(4)}`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check if metrics meet minimum thresholds for deployment.
   */
  meetsDeploymentThresholds(
    metrics: EvaluationMetrics,
    thresholds: Partial<EvaluationMetrics>,
  ): { passes: boolean; failures: string[] } {
    const failures: string[] = [];

    for (const [key, threshold] of Object.entries(thresholds)) {
      const actual = (metrics as Record<string, unknown>)[key];
      if (typeof actual === 'number' && typeof threshold === 'number') {
        if (key === 'logloss' || key === 'mae' || key === 'rmse') {
          if (actual > threshold) failures.push(`${key}: ${actual.toFixed(4)} > ${threshold} (threshold)`);
        } else {
          if (actual < threshold) failures.push(`${key}: ${actual.toFixed(4)} < ${threshold} (threshold)`);
        }
      }
    }

    return { passes: failures.length === 0, failures };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private dcgAtK(predicted: string[], relevant: Set<string>, k: number): number {
    let dcg = 0;
    const topK = predicted.slice(0, k);
    for (let i = 0; i < topK.length; i++) {
      const rel = relevant.has(topK[i]) ? 1 : 0;
      dcg += rel / Math.log2(i + 2);
    }
    return dcg;
  }

  private dcgFromRelevance(relevance: number[], k: number): number {
    let dcg = 0;
    for (let i = 0; i < Math.min(k, relevance.length); i++) {
      dcg += relevance[i] / Math.log2(i + 2);
    }
    return dcg;
  }
}
