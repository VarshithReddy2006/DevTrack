import {
  DAY_IN_MS,
  INITIAL_EASE_FACTOR,
  ratingToQuality,
  calculateEaseFactor,
  calculateIntervalDays,
  type Sm2Rating,
} from './interval.js';

export interface Sm2State {
  repetitions: number;
  easeFactor: number;
  intervalDays: number;
  dueAt: Date;
  lastReviewedAt: Date;
}

export function createInitialSm2State(now: Date = new Date()): Sm2State {
  return {
    repetitions: 0,
    easeFactor: INITIAL_EASE_FACTOR,
    intervalDays: 1,
    dueAt: new Date(now.getTime() + DAY_IN_MS),
    lastReviewedAt: now,
  };
}

/**
 * Computes the next SM-2 state given the current state and a developer's review rating.
 *
 * @param currentState Current card spaced repetition state
 * @param rating 'failed' | 'hard' | 'easy'
 * @param now Optional review evaluation timestamp (defaults to current time)
 */
export function nextState(
  currentState: Sm2State,
  rating: Sm2Rating,
  now: Date = new Date()
): Sm2State {
  const quality = ratingToQuality(rating);
  const newEf = calculateEaseFactor(currentState.easeFactor, quality);

  const nextIntervalDays = calculateIntervalDays(
    quality,
    currentState.repetitions,
    currentState.intervalDays,
    newEf
  );

  const nextRepetitions = quality < 3 ? 0 : currentState.repetitions + 1;
  const dueAt = new Date(now.getTime() + nextIntervalDays * DAY_IN_MS);

  return {
    repetitions: nextRepetitions,
    easeFactor: newEf,
    intervalDays: nextIntervalDays,
    dueAt,
    lastReviewedAt: now,
  };
}
