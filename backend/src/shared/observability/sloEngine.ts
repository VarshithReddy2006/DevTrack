// src/shared/observability/sloEngine.ts — SLO compliance and multi-window burn rates.
//
// Pure calculation over request outcomes. Callers feed one outcome per request and ask for a
// snapshot; storage of the samples (in memory here, a Redis buffer later) is not this module's job.

export interface SloTargets {
  /** Fraction of requests that must succeed, e.g. 0.995. */
  availability: number;
  /** A request is "fast" when it finishes under this many ms. */
  latencyThresholdMs: number;
  /** Fraction of requests that must be fast, e.g. 0.95. */
  latencyTarget: number;
  /** SLO window, used for the remaining-budget figure. */
  windowMs: number;
}

export const DEFAULT_SLO_TARGETS: SloTargets = {
  availability: 0.995,
  latencyThresholdMs: 120,
  latencyTarget: 0.95,
  windowMs: 30 * 24 * 60 * 60 * 1000,
};

export interface RequestOutcome {
  at: number; // epoch ms
  status: number;
  durationMs: number;
  /** LLM-backed routes are excluded from the latency SLO. */
  llm?: boolean;
}

export interface BurnWindowPair {
  name: 'critical' | 'warning';
  longMs: number;
  shortMs: number;
  threshold: number;
}

// Google SRE workbook: page at 14.4x over 1h (confirmed over 5m), ticket at 6x over 6h (confirmed over 30m).
export const BURN_WINDOWS: BurnWindowPair[] = [
  { name: 'critical', longMs: 60 * 60 * 1000, shortMs: 5 * 60 * 1000, threshold: 14.4 },
  { name: 'warning', longMs: 6 * 60 * 60 * 1000, shortMs: 30 * 60 * 1000, threshold: 6 },
];

const isFailure = (o: RequestOutcome): boolean => o.status >= 500;

/** Burn rate = observed bad ratio / allowed bad ratio. 1.0 spends the budget exactly over the SLO window. */
export function burnRate(bad: number, total: number, target: number): number {
  const allowed = 1 - target;
  if (total <= 0 || allowed <= 0) return 0;
  return bad / total / allowed;
}

/** budgetRemaining = 1 - failures / allowedFailures. Not floored, so an overspent budget shows as negative. */
export function budgetRemaining(bad: number, total: number, target: number): number {
  const allowedBad = total * (1 - target);
  if (allowedBad <= 0) return bad === 0 ? 1 : 0;
  return 1 - bad / allowedBad;
}

export interface SloSignal {
  slo: 'availability' | 'latency';
  window: BurnWindowPair['name'];
  longBurn: number;
  shortBurn: number;
  threshold: number;
}

type SloKey = 'availability' | 'latency';
type BurnPair = { long: number; short: number };

export interface SloSnapshot {
  availability: { target: number; compliance: number; budgetRemaining: number; total: number };
  latency: { target: number; thresholdMs: number; compliance: number; budgetRemaining: number; total: number };
  burn: Record<SloKey, Record<BurnWindowPair['name'], BurnPair>>;
  firing: SloSignal[];
  /** True when any critical (14.4x) signal is firing. */
  degraded: boolean;
}

function within(outcomes: RequestOutcome[], now: number, ms: number): RequestOutcome[] {
  const from = now - ms;
  return outcomes.filter((o) => o.at > from && o.at <= now);
}

function stats(list: RequestOutcome[], bad: (o: RequestOutcome) => boolean): { bad: number; total: number } {
  let b = 0;
  for (const o of list) if (bad(o)) b += 1;
  return { bad: b, total: list.length };
}

export function evaluateSlo(outcomes: RequestOutcome[], now: number, targets: SloTargets = DEFAULT_SLO_TARGETS): SloSnapshot {
  const slow = (o: RequestOutcome) => o.durationMs >= targets.latencyThresholdMs;
  const sets: Record<SloKey, { pick: (l: RequestOutcome[]) => RequestOutcome[]; bad: (o: RequestOutcome) => boolean; target: number }> = {
    availability: { pick: (l) => l, bad: isFailure, target: targets.availability },
    latency: { pick: (l) => l.filter((o) => !o.llm), bad: slow, target: targets.latencyTarget },
  };

  const empty = (): Record<BurnWindowPair['name'], BurnPair> => ({
    critical: { long: 0, short: 0 },
    warning: { long: 0, short: 0 },
  });
  const burn: SloSnapshot['burn'] = { availability: empty(), latency: empty() };
  const firing: SloSignal[] = [];

  for (const key of ['availability', 'latency'] as const) {
    const s = sets[key];
    for (const w of BURN_WINDOWS) {
      const long = stats(s.pick(within(outcomes, now, w.longMs)), s.bad);
      const short = stats(s.pick(within(outcomes, now, w.shortMs)), s.bad);
      const longBurn = burnRate(long.bad, long.total, s.target);
      const shortBurn = burnRate(short.bad, short.total, s.target);
      burn[key][w.name] = { long: longBurn, short: shortBurn };
      // Both windows must be over the line: the long one proves it is real, the short one proves it is still happening.
      if (longBurn >= w.threshold && shortBurn >= w.threshold) {
        firing.push({ slo: key, window: w.name, longBurn, shortBurn, threshold: w.threshold });
      }
    }
  }

  const monthly = within(outcomes, now, targets.windowMs);
  const all = stats(monthly, isFailure);
  const latStats = stats(sets.latency.pick(monthly), slow);

  return {
    availability: {
      target: targets.availability,
      compliance: all.total === 0 ? 1 : 1 - all.bad / all.total,
      budgetRemaining: budgetRemaining(all.bad, all.total, targets.availability),
      total: all.total,
    },
    latency: {
      target: targets.latencyTarget,
      thresholdMs: targets.latencyThresholdMs,
      compliance: latStats.total === 0 ? 1 : 1 - latStats.bad / latStats.total,
      budgetRemaining: budgetRemaining(latStats.bad, latStats.total, targets.latencyTarget),
      total: latStats.total,
    },
    burn,
    firing,
    degraded: firing.some((f) => f.window === 'critical'),
  };
}

export interface BurnAlertPayload {
  severity: 'critical' | 'warning';
  slo: SloKey;
  longBurn: number;
  shortBurn: number;
  threshold: number;
  at: string;
}

/** Turns firing signals into webhook payloads. Only critical signals are returned unless includeWarnings is set. */
export function buildBurnAlerts(snapshot: SloSnapshot, now: number, includeWarnings = false): BurnAlertPayload[] {
  return snapshot.firing
    .filter((f) => includeWarnings || f.window === 'critical')
    .map((f) => ({
      severity: f.window,
      slo: f.slo,
      longBurn: Number(f.longBurn.toFixed(2)),
      shortBurn: Number(f.shortBurn.toFixed(2)),
      threshold: f.threshold,
      at: new Date(now).toISOString(),
    }));
}
