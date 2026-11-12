import { describe, expect, it } from 'vitest';
import { classifyMomentum } from '../../../modules/readiness/engine/ReadinessMomentumEngine.js';

describe('readiness momentum classification', () => {
  it.each([
    [3, 1, 80, 75, 'improving'],
    [2, 0, 80, 0, 'improving'],
    [0, 1, 0, 80, 'improving'],
    [0, 0, 90, 90, 'stagnating'],
    [-2, -1, 80, 75, 'declining'],
    [3, -1, 80, 80, 'stagnating'],
    [3, -1, 80, 30, 'improving'],
    [3, -1, 30, 80, 'declining'],
    [-3, 1, 30, 80, 'improving'],
  ] as const)('classifies deltas %i / %i with consistency %i / %i', (dsa, projects, solve, contribution, expected) => {
    expect(classifyMomentum(dsa, projects, solve, contribution)).toBe(expected);
  });
});
