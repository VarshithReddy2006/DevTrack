import { describe, expect, it } from 'vitest';
import { analyzeSolveEntropy, normalizedEntropy } from '../../../modules/leagues/solveEntropy.service.js';

describe('normalizedEntropy boundaries', () => {
  it.each([
    ['an empty list', []],
    ['zero total XP', [0, 0, 0, 0, 0, 0, 0]],
    ['one bucket in total', [40]],
    ['XP in only one of several buckets', [0, 0, 40, 0, 0]],
  ])('returns 0 for %s', (_label, values) => {
    expect(normalizedEntropy(values)).toBe(0);
  });

  it.each([2, 3, 5, 6, 7, 11, 100])('returns exactly 1 for an even spread over %i buckets', (k) => {
    expect(normalizedEntropy(Array<number>(k).fill(13))).toBe(1);
  });

  it('matches the Shannon value for a skewed spread', () => {
    // H(0.75, 0.25) = 0.811278..., and log2(2) = 1.
    expect(normalizedEntropy([75, 25])).toBeCloseTo(0.8112781244591328, 12);
    // Empty buckets still count towards n.
    expect(normalizedEntropy([10, 10, 0, 0])).toBeCloseTo(0.5, 12);
  });

  it('handles fractional values', () => {
    expect(normalizedEntropy([0.1, 0.1, 0.1])).toBe(1);
    expect(normalizedEntropy([0.75, 0.25])).toBeCloseTo(0.8112781244591328, 12);
  });

  it.each([
    ['NaN', [Number.NaN, 10, 10]],
    ['Infinity', [Number.POSITIVE_INFINITY, 10, 10]],
    ['-Infinity', [Number.NEGATIVE_INFINITY, 10, 10]],
    ['a negative value', [-15, 10, 10]],
  ])('treats %s as an empty bucket', (_label, values) => {
    expect(normalizedEntropy(values)).toBe(normalizedEntropy([0, 10, 10]));
  });

  it('stays finite and within [0, 1] for extreme magnitudes', () => {
    for (const values of [
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [Number.MAX_VALUE, Number.MAX_VALUE / 2, 1],
      [Number.MIN_VALUE, Number.MIN_VALUE * 3],
      [1e300, 1e-300],
    ]) {
      const h = normalizedEntropy(values);
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
    }
  });
});

describe('analyzeSolveEntropy with no usable XP', () => {
  it('returns finite numbers when every event is zero or junk', () => {
    const at = new Date('2026-11-16T10:00:00.000Z');
    const r = analyzeSolveEntropy(
      [
        { at, xp: 0 },
        { at, xp: Number.NaN },
      ],
      '2026-11-15',
    );
    expect(r).toMatchObject({ rawXp: 0, adjustedXp: 0, entropy: 0, burstShare: 0, verdict: 'normal' });
  });
});
