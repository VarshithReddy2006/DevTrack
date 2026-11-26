// src/modules/focus/keystrokeEntropy.service.ts — tells scripted or stuck-key activity from human input.
//
// A person typing or moving a cursor produces uneven gaps between events. A script pressing a key
// every 2 s, or a key held down, produces almost identical gaps. This looks at the gaps (and, when
// supplied, the repeat rate of the same key) and returns a verdict the focus session code can use
// before it awards XP. Pure and cheap: the DFT input is capped, so this stays well under a few ms.

export interface KeystrokeEntropyConfig {
  /** Fewer gaps than this and we cannot judge: the session is not penalised. */
  minSamples: number;
  /** CV below this means near-perfectly periodic input. */
  syntheticCv: number;
  /** CV above this is clearly human. */
  humanCv: number;
  /** Share of identical consecutive keys above which input counts as a stuck or scripted key. */
  repeatRateLimit: number;
  /** Cap on gaps fed to the spectral step. */
  maxSpectralSamples: number;
}

export const DEFAULT_KEYSTROKE_CONFIG: KeystrokeEntropyConfig = {
  minSamples: 20,
  syntheticCv: 0.15,
  humanCv: 0.4,
  repeatRateLimit: 0.9,
  maxSpectralSamples: 256,
};

export type KeystrokeVerdict = 'human' | 'uncertain' | 'insufficient_data' | 'synthetic_activity_detected';

export interface KeystrokeAnalysis {
  samples: number;
  mean: number;
  stdDev: number;
  /** Coefficient of variation, sigma / mu. */
  cv: number;
  /** Normalized spectral entropy of the gap series, 0 (single tone) to 1 (white noise). */
  spectralEntropy: number;
  /** Share of consecutive events with the same key, or 0 when no keys were given. */
  repeatRate: number;
  verdict: KeystrokeVerdict;
  /** False only for synthetic activity. Uncertain and short sessions keep their XP. */
  awardXp: boolean;
  reason?: string;
}

function meanOf(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Normalized entropy of the power spectrum of the mean-removed series. 0 when the series is flat. */
export function spectralEntropy(series: number[]): number {
  const n = series.length;
  if (n < 4) return 0;
  const mu = meanOf(series);
  const x = series.map((v) => v - mu);
  const bins = Math.floor(n / 2);
  // bins >= 2 when n >= 4, so Math.log2(bins) >= 1 and is always positive.
  // Guard defensively in case of future callers passing edge-case lengths.
  if (bins < 2) return 0;
  const power: number[] = [];
  for (let k = 1; k <= bins; k++) {
    let re = 0;
    let im = 0;
    for (let t = 0; t < n; t++) {
      const angle = (2 * Math.PI * k * t) / n;
      re += x[t] * Math.cos(angle);
      im -= x[t] * Math.sin(angle);
    }
    power.push(re * re + im * im);
  }
  const total = power.reduce((a, b) => a + b, 0);
  // Float noise from a perfectly flat series should not read as a spectrum.
  if (total < 1e-9 * n * n) return 0;
  let h = 0;
  for (const p of power) {
    if (p <= 0) continue;
    const q = p / total;
    h -= q * Math.log2(q);
  }
  // Clamp to [0, 1]: mathematically h / log2(bins) is in [0, 1] but guard
  // against floating-point rounding producing values just outside the range.
  return Math.max(0, Math.min(1, h / Math.log2(bins)));
}

export function repeatRateOf(keys: string[]): number {
  if (keys.length < 2) return 0;
  let same = 0;
  for (let i = 1; i < keys.length; i++) if (keys[i] === keys[i - 1]) same += 1;
  return same / (keys.length - 1);
}

/**
 * @param gapsMs   time between consecutive interaction events, in ms
 * @param keys     optional key identifiers aligned with the events (gaps.length + 1 entries, or any length)
 */
export function analyzeKeystrokeEntropy(
  gapsMs: number[],
  keys: string[] = [],
  config: KeystrokeEntropyConfig = DEFAULT_KEYSTROKE_CONFIG,
): KeystrokeAnalysis {
  const gaps = gapsMs.filter((g) => Number.isFinite(g) && g >= 0);
  const repeatRate = repeatRateOf(keys);
  const samples = gaps.length;

  if (samples === 0) {
    return { samples, mean: 0, stdDev: 0, cv: 0, spectralEntropy: 0, repeatRate, verdict: 'insufficient_data', awardXp: true };
  }

  const mean = meanOf(gaps);
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / samples;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : 0;
  const entropy = spectralEntropy(gaps.slice(-config.maxSpectralSamples));
  const base = { samples, mean, stdDev, cv, spectralEntropy: entropy, repeatRate };

  if (repeatRate > config.repeatRateLimit && keys.length >= config.minSamples) {
    return { ...base, verdict: 'synthetic_activity_detected', awardXp: false, reason: 'identical key repeated' };
  }
  if (samples < config.minSamples) {
    return { ...base, verdict: 'insufficient_data', awardXp: true };
  }
  // mean 0 means every event had the same timestamp: a burst, not typing.
  if (mean === 0 || cv < config.syntheticCv) {
    return { ...base, verdict: 'synthetic_activity_detected', awardXp: false, reason: 'periodic intervals' };
  }
  if (cv > config.humanCv) return { ...base, verdict: 'human', awardXp: true };
  return { ...base, verdict: 'uncertain', awardXp: true };
}
