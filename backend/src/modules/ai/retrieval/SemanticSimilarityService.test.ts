import { describe, expect, it } from 'vitest';
import { SemanticSimilarityService } from './SemanticSimilarityService.js';

describe('SemanticSimilarityService', () => {
  const service = new SemanticSimilarityService();

  describe('calculate', () => {
    it('delegates to cosine similarity for well-formed vectors', () => {
      expect(service.calculate([1, 0], [1, 0])).toBeCloseTo(1, 10);
      expect(service.calculate([1, 0], [0, 1])).toBeCloseTo(0, 10);
      expect(service.calculate([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    });

    it('returns 0 for empty, mismatched, zero-norm, and non-finite inputs', () => {
      expect(service.calculate([], [])).toBe(0);
      expect(service.calculate([1], [1, 2])).toBe(0);
      expect(service.calculate([0, 0], [1, 1])).toBe(0);
      expect(service.calculate([NaN, 1], [1, 1])).toBe(0);
      expect(service.calculate([1, Infinity], [1, 1])).toBe(0);
      expect(service.calculate([1, -Infinity], [1, 1])).toBe(0);
      expect(service.calculate([1, 1], [NaN, 1])).toBe(0);
    });

    it('never returns NaN or Infinity', () => {
      const score = service.calculate([NaN], [Infinity]);
      expect(Number.isFinite(score)).toBe(true);
    });
  });

  describe('rankCandidates', () => {
    it('ranks candidates by descending similarity', () => {
      const ranked = service.rankCandidates([1, 0], [
        { id: 'orthogonal', vector: [0, 1] },
        { id: 'same', vector: [1, 0] },
        { id: 'opposite', vector: [-1, 0] },
        { id: 'similar', vector: [1, 1] },
      ]);
      expect(ranked.map(r => r.id)).toEqual(['same', 'similar', 'orthogonal', 'opposite']);
      for (const { score } of ranked) expect(Number.isFinite(score)).toBe(true);
    });

    it('keeps input order for ties (deterministic ordering)', () => {
      const ranked = service.rankCandidates([1, 0], [
        { id: 'a', vector: [0, 1] },
        { id: 'b', vector: [0, 1] },
        { id: 'c', vector: [0, 1] },
      ]);
      expect(ranked.map(r => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('remains deterministic when malformed embeddings are present', () => {
      const candidates = [
        { id: 'clean-high', vector: [1, 0] },
        { id: 'nan', vector: [NaN, 0] },
        { id: 'infinity', vector: [Infinity, 0] },
        { id: 'neg-infinity', vector: [-Infinity, 0] },
        { id: 'mismatched', vector: [1, 0, 0] },
        { id: 'empty', vector: [] },
        { id: 'zero', vector: [0, 0] },
        { id: 'clean-low', vector: [0, 1] },
      ];

      const first = service.rankCandidates([1, 0], candidates);
      const second = service.rankCandidates([1, 0], candidates);

      expect(first).toEqual(second);
      for (const { score } of first) expect(Number.isFinite(score)).toBe(true);

      // Highest real score first; malformed embeddings score 0 and keep stable input order.
      expect(first[0].id).toBe('clean-high');
      const scoreOf = (id: string) => first.find(r => r.id === id)!.score;
      expect(scoreOf('nan')).toBe(0);
      expect(scoreOf('infinity')).toBe(0);
      expect(scoreOf('neg-infinity')).toBe(0);
      expect(scoreOf('mismatched')).toBe(0);
      expect(scoreOf('empty')).toBe(0);
      expect(scoreOf('zero')).toBe(0);
      expect(scoreOf('clean-low')).toBe(0);

      const zeroScoreIds = first.filter(r => r.score === 0).map(r => r.id);
      const inputOrderIds = candidates.filter(c => c.id !== 'clean-high').map(c => c.id);
      expect(zeroScoreIds).toEqual(inputOrderIds.filter(id => zeroScoreIds.includes(id)));
    });

    it('scores candidates against a malformed query vector as 0 without throwing', () => {
      const ranked = service.rankCandidates([NaN, Infinity], [
        { id: 'a', vector: [1, 0] },
        { id: 'b', vector: [0, 1] },
      ]);
      expect(ranked.map(r => r.score)).toEqual([0, 0]);
      expect(ranked.map(r => r.id)).toEqual(['a', 'b']);
    });

    it('returns an empty list for no candidates', () => {
      expect(service.rankCandidates([1, 0], [])).toEqual([]);
    });
  });
});
