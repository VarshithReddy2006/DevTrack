import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BKT_PARAMS,
  predictSolveProbability,
  recommendProblems,
  traceMastery,
  updateMastery,
  validateParams,
  ZPD_MAX,
  ZPD_MIN,
  type CandidateProblem,
} from '../../../modules/dsa/recommendation/bktEngine.service.js';

describe('updateMastery', () => {
  it('matches the textbook update for a correct answer', () => {
    // P(L)=0.2, S=0.1, G=0.2, T=0.15
    // posterior = 0.2*0.9 / (0.2*0.9 + 0.8*0.2) = 0.18 / 0.34 = 0.5294...
    // next = 0.5294 + 0.4706*0.15 = 0.6
    expect(updateMastery(0.2, true)).toBeCloseTo(0.6, 3);
  });

  it('matches the textbook update for a wrong answer', () => {
    // posterior = 0.2*0.1 / (0.2*0.1 + 0.8*0.8) = 0.02 / 0.66 = 0.0303
    // next = 0.0303 + 0.9697*0.15 = 0.1758
    expect(updateMastery(0.2, false)).toBeCloseTo(0.1758, 3);
  });

  it('goes up on a solve and down on a failure (once past the learning bump)', () => {
    expect(updateMastery(0.5, true)).toBeGreaterThan(0.5);
    expect(updateMastery(0.5, false)).toBeLessThan(0.5);
  });

  it('treats a slip after strong mastery as a small dent, not a collapse', () => {
    const after = updateMastery(0.95, false);
    expect(after).toBeGreaterThan(0.7);
    expect(after).toBeLessThan(0.95);
  });

  it('never leaves (0, 1)', () => {
    let p = 0.5;
    for (let i = 0; i < 200; i++) p = updateMastery(p, true);
    expect(p).toBeLessThan(1);
    for (let i = 0; i < 200; i++) p = updateMastery(p, false);
    expect(p).toBeGreaterThan(0);
  });
});

describe('traceMastery', () => {
  it('converges toward 1 over ten consecutive solves', () => {
    const trace = traceMastery(Array(10).fill(true));
    for (let i = 1; i < trace.length; i++) expect(trace[i]).toBeGreaterThan(trace[i - 1]);
    expect(trace[9]).toBeGreaterThan(0.98);
  });

  it('falls after repeated failures', () => {
    const start = updateMastery(DEFAULT_BKT_PARAMS.pInit, true);
    const trace = traceMastery([true, false, false, false, false]);
    expect(trace[0]).toBeCloseTo(start, 6);
    expect(trace[4]).toBeLessThan(trace[0]);
  });

  it('is empty for no attempts', () => {
    expect(traceMastery([])).toEqual([]);
  });
});

describe('validateParams', () => {
  it('rejects out-of-range and degenerate values', () => {
    expect(() => validateParams({ ...DEFAULT_BKT_PARAMS, pLearn: 1.2 })).toThrow(RangeError);
    expect(() => validateParams({ ...DEFAULT_BKT_PARAMS, pGuess: Number.NaN })).toThrow(RangeError);
    expect(() => validateParams({ ...DEFAULT_BKT_PARAMS, pGuess: 0.6, pSlip: 0.5 })).toThrow(RangeError);
  });
});

describe('predictSolveProbability', () => {
  it('rises with mastery and falls with difficulty', () => {
    expect(predictSolveProbability(0.9, 0.5)).toBeGreaterThan(predictSolveProbability(0.3, 0.5));
    expect(predictSolveProbability(0.6, 0.1)).toBeGreaterThan(predictSolveProbability(0.6, 0.9));
  });
  it('stays a probability', () => {
    for (const p of [0, 0.5, 1]) for (const d of [-1, 0, 0.5, 1, 2]) {
      const v = predictSolveProbability(p, d);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('recommendProblems', () => {
  const pool: CandidateProblem[] = [
    { id: 'tree-easy', topic: 'trees', difficulty: 0.2 },
    { id: 'tree-med', topic: 'trees', difficulty: 0.5 },
    { id: 'tree-hard', topic: 'trees', difficulty: 0.8 },
    { id: 'dp-easy', topic: 'dp', difficulty: 0.2 },
    { id: 'dp-med', topic: 'dp', difficulty: 0.5 },
    { id: 'dp-hard', topic: 'dp', difficulty: 0.8 },
  ];

  it('returns at most `limit` problems', () => {
    expect(recommendProblems(pool, {}, 3)).toHaveLength(3);
    expect(recommendProblems(pool, {}, 0)).toEqual([]);
  });

  it('puts in-zone problems first and they sit inside 65-75%', () => {
    const recs = recommendProblems(pool, { trees: 0.8, dp: 0.3 }, 6);
    const inZone = recs.filter((r) => r.inZone);
    expect(inZone.length).toBeGreaterThan(0);
    for (const r of inZone) {
      expect(r.solveProbability).toBeGreaterThanOrEqual(ZPD_MIN);
      expect(r.solveProbability).toBeLessThanOrEqual(ZPD_MAX);
    }
    expect(recs.slice(0, inZone.length).every((r) => r.inZone)).toBe(true);
  });

  it('gives a strong topic harder problems than a weak one', () => {
    const strong = recommendProblems(pool.filter((p) => p.topic === 'trees'), { trees: 0.95 }, 1)[0];
    const weak = recommendProblems(pool.filter((p) => p.topic === 'trees'), { trees: 0.1 }, 1)[0];
    expect(strong.difficulty).toBeGreaterThan(weak.difficulty);
  });

  it('cold start uses the prior and does not throw', () => {
    const recs = recommendProblems(pool, {});
    expect(recs).toHaveLength(3);
    expect(recs.every((r) => Number.isFinite(r.solveProbability))).toBe(true);
  });

  it('is deterministic on ties', () => {
    const a = recommendProblems(pool, {}, 6).map((r) => r.id);
    const b = recommendProblems([...pool].reverse(), {}, 6).map((r) => r.id);
    expect(a).toEqual(b);
  });
});
