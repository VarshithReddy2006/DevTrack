import { CosineSimilarityEngine } from './CosineSimilarityEngine.js';

export interface SimilarityCandidate {
  id: string;
  vector: number[];
}

export interface RankedCandidate {
  id: string;
  score: number;
}

export class SemanticSimilarityService {
  private engine: CosineSimilarityEngine;

  constructor() {
    this.engine = new CosineSimilarityEngine();
  }

  /**
   * Cosine similarity in [-1, 1]; safe 0 for empty, mismatched, zero-norm,
   * or non-finite inputs. Never returns NaN or Infinity.
   */
  calculate(vectorA: number[], vectorB: number[]): number {
    const score = this.engine.calculateSimilarity(vectorA, vectorB);
    return Number.isFinite(score) ? score : 0;
  }

  /**
   * Rank candidates by descending similarity. Scores are always finite, and
   * ordering is deterministic: ties keep input order, and malformed embeddings
   * (non-finite values, dimension mismatches, empty vectors) score 0 rather
   * than breaking `Array.prototype.sort` or propagating an error.
   */
  rankCandidates(queryVector: number[], candidates: SimilarityCandidate[]): RankedCandidate[] {
    return candidates
      .map((c, index) => ({
        id: c.id,
        score: this.calculate(queryVector, c.vector),
        index,
      }))
      .sort((a, b) => (b.score - a.score) || (a.index - b.index))
      .map(({ id, score }) => ({ id, score }));
  }
}
