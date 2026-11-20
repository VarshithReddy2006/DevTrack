import { describe, expect, it } from 'vitest';
import { analyzeKeystrokeEntropy, repeatRateOf, spectralEntropy } from '../../../modules/focus/keystrokeEntropy.service.js';

// Small seeded generator so the "human" data is the same on every run.
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Bursty typing: mostly 80-250 ms gaps, with occasional thinking pauses of 1-4 s. */
function humanGaps(n: number, seed = 7): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => (r() < 0.12 ? 1000 + r() * 3000 : 80 + r() * 170));
}

describe('analyzeKeystrokeEntropy', () => {
  it('flags a script pressing a key every 2000 ms', () => {
    const r = analyzeKeystrokeEntropy(Array(60).fill(2000));
    expect(r.verdict).toBe('synthetic_activity_detected');
    expect(r.awardXp).toBe(false);
    expect(r.cv).toBe(0);
    expect(r.spectralEntropy).toBe(0);
  });

  it('flags a script with a little timer jitter', () => {
    const r = analyzeKeystrokeEntropy(Array.from({ length: 60 }, (_, i) => 2000 + (i % 3) * 20));
    expect(r.cv).toBeLessThan(0.15);
    expect(r.verdict).toBe('synthetic_activity_detected');
  });

  it('flags a stuck key by its repeat rate even with irregular timing', () => {
    const gaps = humanGaps(60);
    const keys = Array(61).fill(' ');
    const r = analyzeKeystrokeEntropy(gaps, keys);
    expect(r.repeatRate).toBe(1);
    expect(r.verdict).toBe('synthetic_activity_detected');
    expect(r.awardXp).toBe(false);
  });

  it('accepts natural bursty typing', () => {
    const gaps = humanGaps(200);
    const keys = gaps.map((_, i) => 'abcdefghij'[i % 10]);
    const r = analyzeKeystrokeEntropy(gaps, keys);
    expect(r.cv).toBeGreaterThan(0.4);
    expect(r.verdict).toBe('human');
    expect(r.awardXp).toBe(true);
    expect(r.spectralEntropy).toBeGreaterThan(0.5);
  });

  it('keeps XP for the in-between band', () => {
    // Gaps alternating 100 and 200 ms: CV is about 0.33.
    const r = analyzeKeystrokeEntropy(Array.from({ length: 40 }, (_, i) => (i % 2 ? 200 : 100)));
    expect(r.cv).toBeGreaterThan(0.15);
    expect(r.cv).toBeLessThan(0.4);
    expect(r.verdict).toBe('uncertain');
    expect(r.awardXp).toBe(true);
  });

  it('does not penalise a session with too little data', () => {
    const r = analyzeKeystrokeEntropy(Array(5).fill(2000));
    expect(r.verdict).toBe('insufficient_data');
    expect(r.awardXp).toBe(true);
    expect(analyzeKeystrokeEntropy([]).awardXp).toBe(true);
  });

  it('drops invalid gaps instead of throwing', () => {
    const r = analyzeKeystrokeEntropy([Number.NaN, -5, Infinity, ...humanGaps(40)]);
    expect(r.samples).toBe(40);
    expect(r.verdict).toBe('human');
  });

  it('treats a pile of events with identical timestamps as a burst', () => {
    expect(analyzeKeystrokeEntropy(Array(30).fill(0)).verdict).toBe('synthetic_activity_detected');
  });

  it('runs fast on a long session', () => {
    const gaps = humanGaps(5000);
    const t0 = performance.now();
    analyzeKeystrokeEntropy(gaps);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('helpers', () => {
  it('repeatRateOf counts consecutive identical keys', () => {
    expect(repeatRateOf(['a', 'a', 'a', 'b'])).toBeCloseTo(2 / 3, 10);
    expect(repeatRateOf(['a'])).toBe(0);
  });
  it('spectralEntropy is low for a pure tone and high for noise', () => {
    const tone = Array.from({ length: 64 }, (_, i) => Math.sin((2 * Math.PI * 4 * i) / 64));
    const r = rng(3);
    const noise = Array.from({ length: 64 }, () => r());
    expect(spectralEntropy(tone)).toBeLessThan(0.2);
    expect(spectralEntropy(noise)).toBeGreaterThan(0.8);
  });
});
