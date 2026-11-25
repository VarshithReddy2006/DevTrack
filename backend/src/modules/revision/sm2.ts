// src/modules/revision/sm2.ts — Pure SuperMemo-2 (SM-2) engine helper
export const INITIAL_EASE_FACTOR = 2.5;
export const MIN_EASE_FACTOR = 1.3;
export const DAY_IN_MS = 24 * 60 * 60 * 1000;

export type ReviewRating = 'failed' | 'hard' | 'easy';

export interface Sm2CalculationResult {
  repetitions: number;
  easeFactor: number;
  intervalDays: number;
  dueAt: Date;
}

export function ratingToQuality(rating: ReviewRating): number {
  switch (rating) {
    case 'failed':
      return 1;
    case 'hard':
      return 3;
    case 'easy':
      return 5;
  }
}

export function calculateEaseFactor(currentEf: number, quality: number): number {
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  const newEf = currentEf + delta;
  return Math.max(MIN_EASE_FACTOR, Math.round(newEf * 100) / 100);
}

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

/**
 * Normalizes a due date to the UTC calendar-day boundary (00:00:00.000Z)
 * `intervalDays` days after `now`'s UTC calendar date, preventing daily review
 * time-of-day drift and daylight saving time shifts.
 */
export function normalizeDueAt(now: Date, intervalDays: number): Date {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('normalizeDueAt requires a valid Date');
  }
  const days = Number.isFinite(intervalDays) ? Math.max(0, Math.trunc(intervalDays)) : 0;
  const utcDayStartMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  return new Date(utcDayStartMs + days * DAY_IN_MS);
}

export function computeNextSm2State(
  current: { repetitions: number; easeFactor: number; intervalDays: number },
  rating: ReviewRating,
  now: Date = new Date()
): Sm2CalculationResult {
  const quality = ratingToQuality(rating);
  const nextEf = calculateEaseFactor(current.easeFactor, quality);
  const nextIntervalDays = calculateIntervalDays(
    quality,
    current.repetitions,
    current.intervalDays,
    nextEf
  );
  const nextRepetitions = quality < 3 ? 0 : current.repetitions + 1;
  const dueAt = normalizeDueAt(now, nextIntervalDays);

  return {
    repetitions: nextRepetitions,
    easeFactor: nextEf,
    intervalDays: nextIntervalDays,
    dueAt,
  };
}
