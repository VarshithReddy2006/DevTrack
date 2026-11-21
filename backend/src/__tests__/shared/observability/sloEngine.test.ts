import { describe, expect, it } from 'vitest';
import { budgetRemaining, buildBurnAlerts, burnRate, evaluateSlo, type RequestOutcome } from '../../../shared/observability/sloEngine.js';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const MIN = 60_000;

/** One request per second for `minutes`, ending `endAgoMin` minutes before NOW, with the given failure ratio. */
function traffic(minutes: number, endAgoMin: number, failRatio: number, durationMs = 40): RequestOutcome[] {
  const out: RequestOutcome[] = [];
  const end = NOW - endAgoMin * MIN;
  const count = minutes * 60;
  for (let i = 0; i < count; i++) {
    const failed = (i % 1000) / 1000 < failRatio;
    out.push({ at: end - i * 1000, status: failed ? 503 : 200, durationMs });
  }
  return out;
}

describe('burnRate and budgetRemaining', () => {
  it('is 1.0 when failures match the allowed ratio', () => {
    expect(burnRate(5, 1000, 0.995)).toBeCloseTo(1, 6);
  });
  it('is 14.4 at 7.2% errors against a 99.5% SLO', () => {
    expect(burnRate(72, 1000, 0.995)).toBeCloseTo(14.4, 6);
  });
  it('handles empty traffic', () => {
    expect(burnRate(0, 0, 0.995)).toBe(0);
    expect(budgetRemaining(0, 0, 0.995)).toBe(1);
  });
  it('goes negative once the budget is overspent', () => {
    expect(budgetRemaining(10, 1000, 0.995)).toBeCloseTo(-1, 6);
    expect(budgetRemaining(0, 1000, 0.995)).toBe(1);
  });
});

describe('evaluateSlo', () => {
  it('stays quiet on healthy traffic', () => {
    const snap = evaluateSlo(traffic(120, 0, 0), NOW);
    expect(snap.firing).toEqual([]);
    expect(snap.degraded).toBe(false);
    expect(snap.availability.compliance).toBe(1);
    expect(snap.availability.budgetRemaining).toBe(1);
  });

  it('does not alert on a minor degradation under the warning threshold', () => {
    // 1% errors is a 2x burn: spends budget faster than planned but nothing to page on.
    const snap = evaluateSlo(traffic(120, 0, 0.01), NOW);
    expect(snap.burn.availability.critical.long).toBeCloseTo(2, 0);
    expect(snap.firing).toEqual([]);
  });

  it('raises a warning at 6x sustained for hours', () => {
    const snap = evaluateSlo(traffic(360, 0, 0.03), NOW);
    expect(snap.firing.map((f) => `${f.slo}:${f.window}`)).toContain('availability:warning');
    expect(snap.degraded).toBe(false);
  });

  it('pages on a rapid burn and marks degraded', () => {
    const snap = evaluateSlo([...traffic(55, 5, 0), ...traffic(5, 0, 0.5)], NOW);
    const crit = snap.firing.find((f) => f.slo === 'availability' && f.window === 'critical');
    expect(crit).toBeDefined();
    expect(snap.degraded).toBe(true);
    const alerts = buildBurnAlerts(snap, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'critical', slo: 'availability', threshold: 14.4 });
  });

  it('does not keep paging once the short window has recovered', () => {
    // A bad hour that ended 30 minutes ago: the long window is still hot, the 5m window is clean.
    const snap = evaluateSlo([...traffic(30, 0, 0), ...traffic(30, 30, 0.4)], NOW);
    expect(snap.burn.availability.critical.long).toBeGreaterThan(14.4);
    expect(snap.burn.availability.critical.short).toBe(0);
    expect(snap.degraded).toBe(false);
  });

  it('tracks the latency SLO and ignores LLM routes', () => {
    const slow = traffic(10, 0, 0, 500);
    const llm = slow.map((o) => ({ ...o, llm: true }));
    expect(evaluateSlo(slow, NOW).latency.compliance).toBe(0);
    const snap = evaluateSlo(llm, NOW);
    expect(snap.latency.total).toBe(0);
    expect(snap.latency.compliance).toBe(1);
  });

  it('ignores samples older than the SLO window', () => {
    const old: RequestOutcome[] = [{ at: NOW - 31 * 24 * 60 * MIN, status: 500, durationMs: 10 }];
    expect(evaluateSlo(old, NOW).availability.total).toBe(0);
  });
});

describe('buildBurnAlerts', () => {
  it('only includes warnings on request', () => {
    const snap = evaluateSlo(traffic(360, 0, 0.03), NOW);
    expect(buildBurnAlerts(snap, NOW)).toEqual([]);
    expect(buildBurnAlerts(snap, NOW, true).length).toBeGreaterThan(0);
  });
});
