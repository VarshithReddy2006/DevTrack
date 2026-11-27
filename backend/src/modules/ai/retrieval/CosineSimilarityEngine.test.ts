import { describe, expect, it } from 'vitest';
import { CosineSimilarityEngine } from './CosineSimilarityEngine.js';

describe('CosineSimilarityEngine', () => {
  const engine = new CosineSimilarityEngine();

  describe('well-formed vectors', () => {
    it('returns 1 for identical vectors', () => {
      expect(engine.calculateSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    });

    it('returns -1 for opposite vectors', () => {
      expect(engine.calculateSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 10);
    });

    it('returns 0 for orthogonal vectors', () => {
      expect(engine.calculateSimilarity([1, 0], [0, 1])).toBe(0);
    });

    it('computes exact cosine for a known pair', () => {
      const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
      expect(engine.calculateSimilarity([1, 2, 3], [4, 5, 6])).toBeCloseTo(expected, 10);
    });

    it('is scale invariant', () => {
      expect(engine.calculateSimilarity([1, 2], [2, 4])).toBeCloseTo(1, 10);
      expect(engine.calculateSimilarity([2, 4], [1, 2])).toBeCloseTo(1, 10);
    });
  });

  describe('clamping floating-point overshoot', () => {
    it('clamps results above 1 back to exactly 1', () => {
      // Raw dot/(sqrtA*sqrtB) for this pair is 1.0000000000000002 in IEEE-754.
      expect(engine.calculateSimilarity([1, 1, 1], [1, 1, 1])).toBe(1);
    });

    it('clamps results below -1 back to exactly -1', () => {
      expect(engine.calculateSimilarity([1, 1, 1], [-1, -1, -1])).toBe(-1);
    });

    it('never returns a value outside [-1, 1]', () => {
      const samples: number[][] = [
        [1, 1, 1], [1, 1, 1], [3, 4], [3, 4], [0.1, 0.2], [0.3, 0.4],
        [1e8, 1e8], [1e8, 1e8], [1, 2, 3], [2, 4, 6], [7, 24], [7, 24],
      ];
      for (let i = 0; i + 1 < samples.length; i += 2) {
        const score = engine.calculateSimilarity(samples[i], samples[i + 1]);
        expect(score).toBeGreaterThanOrEqual(-1);
        expect(score).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('empty and mismatched inputs', () => {
    it('returns 0 for two empty vectors', () => {
      expect(engine.calculateSimilarity([], [])).toBe(0);
    });

    it('returns 0 for empty vs non-empty', () => {
      expect(engine.calculateSimilarity([], [1, 2])).toBe(0);
      expect(engine.calculateSimilarity([1, 2], [])).toBe(0);
    });

    it('returns 0 for dimension mismatches', () => {
      expect(engine.calculateSimilarity([1, 2], [1, 2, 3])).toBe(0);
      expect(engine.calculateSimilarity([1, 2, 3], [1, 2])).toBe(0);
      expect(engine.calculateSimilarity([1], [1, 2, 3, 4])).toBe(0);
    });
  });

  describe('zero-norm vectors', () => {
    it('returns 0 when either vector has zero L2 norm', () => {
      expect(engine.calculateSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
      expect(engine.calculateSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
      expect(engine.calculateSimilarity([0, 0], [0, 0])).toBe(0);
    });
  });

  describe('non-finite values', () => {
    it('returns 0 when NaN appears in either vector', () => {
      expect(engine.calculateSimilarity([NaN, 1], [1, 1])).toBe(0);
      expect(engine.calculateSimilarity([1, 1], [NaN, 1])).toBe(0);
      expect(engine.calculateSimilarity([1, NaN, 1], [1, 1, 1])).toBe(0);
      expect(engine.calculateSimilarity([NaN], [NaN])).toBe(0);
    });

    it('returns 0 when Infinity appears in either vector', () => {
      expect(engine.calculateSimilarity([Infinity, 1], [1, 1])).toBe(0);
      expect(engine.calculateSimilarity([1, 1], [Infinity, 1])).toBe(0);
      expect(engine.calculateSimilarity([1, Infinity], [1, Infinity])).toBe(0);
    });

    it('returns 0 when -Infinity appears in either vector', () => {
      expect(engine.calculateSimilarity([-Infinity, 1], [1, 1])).toBe(0);
      expect(engine.calculateSimilarity([1, 1], [-Infinity, 1])).toBe(0);
      expect(engine.calculateSimilarity([-Infinity], [1])).toBe(0);
    });

    it('never emits NaN or Infinity', () => {
      const malformed: number[][] = [
        [NaN], [Infinity], [-Infinity], [0], [1], [NaN, Infinity], [Infinity, -Infinity],
      ];
      for (const a of malformed) {
        for (const b of malformed) {
          const score = engine.calculateSimilarity(a, b);
          expect(Number.isFinite(score)).toBe(true);
        }
      }
    });

    it('returns a safe 0 instead of NaN when accumulation would overflow', () => {
      // normA/normB/dotProduct would become Infinity; Infinity/Infinity must not leak NaN.
      const huge = [Number.MAX_VALUE, Number.MAX_VALUE];
      expect(engine.calculateSimilarity(huge, huge)).toBe(0);
      expect(Number.isFinite(engine.calculateSimilarity(huge, huge))).toBe(true);
    });
  });
});
