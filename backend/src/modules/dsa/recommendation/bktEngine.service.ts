// src/modules/dsa/recommendation/bktEngine.service.ts — Bayesian Knowledge Tracing for DSA topics.
//
// Standard four-parameter BKT. Each topic keeps a mastery probability P(L). After every attempt
// we condition on the outcome, then apply the learning transition:
//
//   correct:   P(L|obs) = P(L)(1-S) / (P(L)(1-S) + (1-P(L))G)
//   incorrect: P(L|obs) = P(L)S     / (P(L)S     + (1-P(L))(1-G))
//   P(L_next)  = P(L|obs) + (1 - P(L|obs)) T
//
// Pure functions only. Persisting mastery per user/topic is left to the caller.

export interface BktParams {
  /** P(L0): prior probability the topic is already known. */
  pInit: number;
  /** P(T): chance of learning the topic after one practice opportunity. */
  pLearn: number;
  /** P(G): chance of a correct answer without knowing the topic. */
  pGuess: number;
  /** P(S): chance of a wrong answer despite knowing the topic. */
  pSlip: number;
}

export const DEFAULT_BKT_PARAMS: BktParams = { pInit: 0.2, pLearn: 0.15, pGuess: 0.2, pSlip: 0.1 };

/** Zone of proximal development: aim for problems the user solves about 70% of the time. */
export const ZPD_MIN = 0.65;
export const ZPD_MAX = 0.75;
export const ZPD_TARGET = 0.7;

// Keeps the posterior away from exactly 0 or 1 so a single odd result can still move it.
const EPS = 1e-6;

function clamp01(x: number): number {
  return Math.min(1 - EPS, Math.max(EPS, x));
}

export function validateParams(p: BktParams): BktParams {
  for (const [k, v] of Object.entries(p)) {
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`BKT parameter ${k} must be in [0, 1], got ${v}`);
  }
  // pGuess + pSlip >= 1 makes the model degenerate (a correct answer would count against mastery).
  if (p.pGuess + p.pSlip >= 1) throw new RangeError('BKT requires pGuess + pSlip < 1');
  return p;
}

/** Posterior mastery after observing one attempt. */
export function updateMastery(pKnown: number, correct: boolean, params: BktParams = DEFAULT_BKT_PARAMS): number {
  const { pLearn, pGuess, pSlip } = validateParams(params);
  const prior = clamp01(pKnown);
  const conditioned = correct
    ? (prior * (1 - pSlip)) / (prior * (1 - pSlip) + (1 - prior) * pGuess)
    : (prior * pSlip) / (prior * pSlip + (1 - prior) * (1 - pGuess));
  return clamp01(conditioned + (1 - conditioned) * pLearn);
}

/** Replays a sequence of outcomes from the prior. Returns the mastery after each attempt. */
export function traceMastery(outcomes: boolean[], params: BktParams = DEFAULT_BKT_PARAMS): number[] {
  const trace: number[] = [];
  let p = params.pInit;
  for (const correct of outcomes) {
    p = updateMastery(p, correct, params);
    trace.push(p);
  }
  return trace;
}

/**
 * Chance of solving a problem on the next attempt. `difficulty` is 0 (trivial) to 1 (very hard) and
 * pulls the guess chance down and the slip chance up, so the same mastery predicts lower success on harder problems.
 */
export function predictSolveProbability(pKnown: number, difficulty = 0.5, params: BktParams = DEFAULT_BKT_PARAMS): number {
  const d = Math.min(1, Math.max(0, difficulty));
  const guess = params.pGuess * (1 - d);
  const slip = Math.min(1 - guess - EPS, params.pSlip + d * 0.3);
  const p = clamp01(pKnown);
  return p * (1 - slip) + (1 - p) * guess;
}

export interface CandidateProblem {
  id: string;
  topic: string;
  /** 0 to 1. Map Easy/Medium/Hard to 0.2/0.5/0.8 when the source has no finer number. */
  difficulty: number;
}

export interface Recommendation extends CandidateProblem {
  solveProbability: number;
  inZone: boolean;
}

export const DIFFICULTY_BY_LABEL: Record<string, number> = { easy: 0.2, medium: 0.5, hard: 0.8 };

/**
 * Picks `limit` problems closest to the 70% target, preferring ones inside 65-75%.
 * `mastery` is keyed by topic; unseen topics start from the prior (cold start).
 * Ties break on id so the result is stable.
 */
export function recommendProblems(
  candidates: CandidateProblem[],
  mastery: Record<string, number>,
  limit = 3,
  params: BktParams = DEFAULT_BKT_PARAMS,
): Recommendation[] {
  const scored = candidates.map((c): Recommendation => {
    const p = mastery[c.topic] ?? params.pInit;
    const solveProbability = predictSolveProbability(p, c.difficulty, params);
    return { ...c, solveProbability, inZone: solveProbability >= ZPD_MIN && solveProbability <= ZPD_MAX };
  });
  scored.sort((a, b) => {
    if (a.inZone !== b.inZone) return a.inZone ? -1 : 1;
    const da = Math.abs(a.solveProbability - ZPD_TARGET);
    const db = Math.abs(b.solveProbability - ZPD_TARGET);
    return da - db || a.id.localeCompare(b.id);
  });
  return scored.slice(0, Math.max(0, limit));
}
