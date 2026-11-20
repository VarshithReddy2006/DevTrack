// src/modules/leagues/solveEntropy.service.ts — detects last-minute XP dumps in a league week.
//
// Looks at when a user's XP was earned across the 7-day league week. If almost all of it lands in
// the final hours and the day-by-day spread is very uneven, the burst is damped for ranking and an
// audit entry is described. Steady daily learners get a small consistency bonus.
//
// Pure: no database or worker access. The rollover worker decides when to call it and what to do with the result.
import { weekRange } from './weeks.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface SolveEntropyConfig {
  /** Window before rollover that counts as "last minute". */
  burstWindowMs: number;
  /** Burst XP share of the week above which a user is suspicious. */
  burstShareThreshold: number;
  /** Normalized entropy below which the week looks concentrated. */
  entropyThreshold: number;
  /** Burst XP is capped at this share of the damped weekly total. */
  burstCapShare: number;
  /** Multiplier for consistent daily learners. */
  consistencyBonus: number;
  /** Minimum active days (out of 7) for the consistency bonus. */
  consistencyMinDays: number;
  /** Minimum normalized entropy for the consistency bonus. */
  consistencyMinEntropy: number;
}

export const DEFAULT_SOLVE_ENTROPY_CONFIG: SolveEntropyConfig = {
  burstWindowMs: 2 * HOUR_MS,
  burstShareThreshold: 0.7,
  entropyThreshold: 0.25,
  burstCapShare: 0.25,
  consistencyBonus: 1.1,
  consistencyMinDays: 5,
  consistencyMinEntropy: 0.7,
};

export interface XpEvent {
  at: Date;
  xp: number;
}

export interface SolveEntropyResult {
  rawXp: number;
  /** XP used for ranking after damping and any bonus. */
  adjustedXp: number;
  dailyXp: number[];
  /** Normalized Shannon entropy of the 7 daily shares, 0 (one day) to 1 (even). */
  entropy: number;
  activeDays: number;
  burstXp: number;
  burstShare: number;
  verdict: 'sniping' | 'consistent' | 'normal';
  /** Present only for sniping: the shape the caller should write to ProfileAuditLog. */
  audit?: { reason: 'leaderboard_sniping_detected'; details: Record<string, number> };
}

/** H = -sum(p_i log2 p_i) / log2(n). Returns 0 for no data or a single bucket. */
export function normalizedEntropy(values: number[]): number {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || values.length < 2) return 0;
  let h = 0;
  for (const v of values) {
    if (v <= 0) continue;
    const p = v / total;
    h -= p * Math.log2(p);
  }
  return h / Math.log2(values.length);
}

export function analyzeSolveEntropy(
  events: XpEvent[],
  weekKey: string,
  config: SolveEntropyConfig = DEFAULT_SOLVE_ENTROPY_CONFIG,
): SolveEntropyResult {
  const { start, end } = weekRange(weekKey);
  const burstFrom = end.getTime() - config.burstWindowMs;
  const dailyXp = Array<number>(7).fill(0);
  let burstXp = 0;
  let rawXp = 0;

  for (const e of events) {
    const t = e.at.getTime();
    // Ignore junk and anything outside the week this analysis is about.
    if (!Number.isFinite(e.xp) || e.xp <= 0 || !(t >= start.getTime() && t < end.getTime())) continue;
    dailyXp[Math.min(6, Math.floor((t - start.getTime()) / DAY_MS))] += e.xp;
    rawXp += e.xp;
    if (t >= burstFrom) burstXp += e.xp;
  }

  const entropy = normalizedEntropy(dailyXp);
  const activeDays = dailyXp.filter((x) => x > 0).length;
  const burstShare = rawXp > 0 ? burstXp / rawXp : 0;

  const base = { rawXp, dailyXp, entropy, activeDays, burstXp, burstShare };

  if (rawXp > 0 && burstShare > config.burstShareThreshold && entropy < config.entropyThreshold) {
    // Cap the burst so it is at most burstCapShare of the damped total: b <= share/(1-share) * rest.
    const rest = rawXp - burstXp;
    const allowedBurst = Math.min(burstXp, (config.burstCapShare / (1 - config.burstCapShare)) * rest);
    const adjustedXp = rest + allowedBurst;
    return {
      ...base,
      adjustedXp,
      verdict: 'sniping',
      audit: {
        reason: 'leaderboard_sniping_detected',
        details: { rawXp, adjustedXp, burstXp, burstShare: round(burstShare), entropy: round(entropy) },
      },
    };
  }

  if (activeDays >= config.consistencyMinDays && entropy >= config.consistencyMinEntropy) {
    return { ...base, adjustedXp: rawXp * config.consistencyBonus, verdict: 'consistent' };
  }

  return { ...base, adjustedXp: rawXp, verdict: 'normal' };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
