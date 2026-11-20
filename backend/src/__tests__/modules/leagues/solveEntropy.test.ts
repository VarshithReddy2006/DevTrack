import { describe, expect, it } from 'vitest';
import { analyzeSolveEntropy, normalizedEntropy, type XpEvent } from '../../../modules/leagues/solveEntropy.service.js';

// 2026-11-15 is a Sunday, so this is a valid league week key. The week ends 2026-11-22T00:00Z.
const WEEK = '2026-11-15';
const START = Date.UTC(2026, 10, 15);
const DAY = 86_400_000;
const HOUR = 3_600_000;

const at = (offsetMs: number, xp: number): XpEvent => ({ at: new Date(START + offsetMs), xp });

describe('normalizedEntropy', () => {
  it('is 0 for a single day and 1 for an even spread', () => {
    expect(normalizedEntropy([0, 0, 90, 0, 0, 0, 0])).toBe(0);
    expect(normalizedEntropy([10, 10, 10, 10, 10, 10, 10])).toBeCloseTo(1, 10);
  });
  it('is 0 for no data', () => {
    expect(normalizedEntropy([0, 0, 0])).toBe(0);
    expect(normalizedEntropy([])).toBe(0);
  });
  it('sits between the two for a lopsided week', () => {
    const h = normalizedEntropy([50, 10, 10, 10, 10, 5, 5]);
    expect(h).toBeGreaterThan(0.5);
    expect(h).toBeLessThan(1);
  });
});

describe('analyzeSolveEntropy', () => {
  it('flags a sniper who dumps the week into the last two hours', () => {
    const events = [at(DAY + HOUR, 20), ...Array.from({ length: 40 }, (_, i) => at(7 * DAY - 90 * 60_000 + i * 1000, 25))];
    const r = analyzeSolveEntropy(events, WEEK);
    expect(r.verdict).toBe('sniping');
    expect(r.burstShare).toBeGreaterThan(0.9);
    expect(r.entropy).toBeLessThan(0.25);
    // 20 earned honestly, so the burst is capped at 20/3 of damped total share (25%).
    expect(r.adjustedXp).toBeCloseTo(20 + 20 / 3, 6);
    expect(r.adjustedXp).toBeLessThan(r.rawXp);
    expect(r.audit?.reason).toBe('leaderboard_sniping_detected');
    expect(r.audit?.details.rawXp).toBe(r.rawXp);
  });

  it('leaves an honest weekend learner alone', () => {
    // Two solid days, nothing in the final hours.
    const events = [at(5 * DAY + 10 * HOUR, 60), at(6 * DAY + 9 * HOUR, 60)];
    const r = analyzeSolveEntropy(events, WEEK);
    expect(r.verdict).toBe('normal');
    expect(r.adjustedXp).toBe(120);
    expect(r.audit).toBeUndefined();
  });

  it('does not flag a busy user who also solves in the last hours but spread over the week', () => {
    const events = [0, 1, 2, 3, 4, 5].map((d) => at(d * DAY + 12 * HOUR, 30)).concat(at(7 * DAY - HOUR, 30));
    const r = analyzeSolveEntropy(events, WEEK);
    expect(r.verdict).not.toBe('sniping');
    expect(r.burstShare).toBeCloseTo(1 / 7, 6);
  });

  it('gives the consistency bonus to steady daily solvers', () => {
    const events = [0, 1, 2, 3, 4, 5, 6].map((d) => at(d * DAY + 14 * HOUR, 40));
    const r = analyzeSolveEntropy(events, WEEK);
    expect(r.verdict).toBe('consistent');
    expect(r.adjustedXp).toBeCloseTo(280 * 1.1, 6);
    expect(r.activeDays).toBe(7);
  });

  it('does not reward a lopsided week with the bonus even if it spans many days', () => {
    const events = [at(0, 300), at(DAY, 5), at(2 * DAY, 5), at(3 * DAY, 5), at(4 * DAY, 5)];
    expect(analyzeSolveEntropy(events, WEEK).verdict).toBe('normal');
  });

  it('ignores events outside the week and junk xp', () => {
    const events = [at(-HOUR, 100), at(7 * DAY, 100), at(DAY, -5), at(DAY, Number.NaN), at(DAY, 10)];
    const r = analyzeSolveEntropy(events, WEEK);
    expect(r.rawXp).toBe(10);
    expect(r.dailyXp[1]).toBe(10);
  });

  it('handles an empty week', () => {
    const r = analyzeSolveEntropy([], WEEK);
    expect(r).toMatchObject({ rawXp: 0, adjustedXp: 0, verdict: 'normal', burstShare: 0 });
  });

  it('throws on an invalid week key', () => {
    expect(() => analyzeSolveEntropy([], '2026-11-16')).toThrow();
  });
});
