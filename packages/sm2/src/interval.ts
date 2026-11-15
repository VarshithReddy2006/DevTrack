export const INITIAL_EASE_FACTOR = 2.5;
export const MIN_EASE_FACTOR = 1.3;
export const DAY_IN_MS = 24 * 60 * 60 * 1000;

export type Sm2Rating = 'failed' | 'hard' | 'easy';

/**
 * Maps categorical rating to SM-2 numeric quality score (q):
 * - 'failed' -> 1 (Complete blackout; problem could not be solved)
 * - 'hard'   -> 3 (Solved with significant difficulty or heavy hints)
 * - 'easy'   -> 5 (Perfect recall; solved smoothly without assistance)
 */
export function ratingToQuality(rating: Sm2Rating): number {
  switch (rating) {
    case 'failed':
      return 1;
    case 'hard':
      return 3;
    case 'easy':
      return 5;
  }
}

/**
 * Calculates new Ease Factor (EF) according to SuperMemo-2 formula:
 * EF' = max(1.3, EF + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
 */
export function calculateEaseFactor(currentEf: number, quality: number): number {
  const efDelta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const newEf = currentEf + efDelta;
  return Math.max(MIN_EASE_FACTOR, Math.round(newEf * 100) / 100);
}

/**
 * Calculates review interval in days based on quality and repetition count.
 * - If quality < 3 ('failed'): returns 1 day (reset).
 * - If quality >= 3:
 *   - Repetition 0: 1 day
 *   - Repetition 1: 3 days
 *   - Repetition 2: 7 days
 *   - Repetition n > 2: round(previousInterval * easeFactor) days
 */
export function calculateIntervalDays(
  quality: number,
  currentRepetitions: number,
  previousIntervalDays: number,
  easeFactor: number
): number {
  if (quality < 3) {
    return 1;
  }

  switch (currentRepetitions) {
    case 0:
      return 1;
    case 1:
      return 3;
    case 2:
      return 7;
    default:
      return Math.max(1, Math.round(previousIntervalDays * easeFactor));
  }
}
