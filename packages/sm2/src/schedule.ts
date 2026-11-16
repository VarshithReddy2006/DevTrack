import {
  DAY_IN_MS,
  INITIAL_EASE_FACTOR,
  MIN_EASE_FACTOR,
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

function timestamp(date: Date, name: string): number {
  const value = date.getTime();
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a valid Date`);
  return value;
}

function scheduledDate(now: number, intervalDays: number): Date {
  const dueAt = new Date(now + intervalDays * DAY_IN_MS);
  timestamp(dueAt, 'dueAt');
  return dueAt;
}

export function createInitialSm2State(now: Date = new Date()): Sm2State {
  const reviewedAt = timestamp(now, 'now');
  return {
    repetitions: 0,
    easeFactor: INITIAL_EASE_FACTOR,
    intervalDays: 1,
    dueAt: scheduledDate(reviewedAt, 1),
    lastReviewedAt: new Date(reviewedAt),
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
  const reviewedAt = timestamp(now, 'now');
  if (!Number.isSafeInteger(currentState.repetitions) || currentState.repetitions < 0 ||
      currentState.repetitions === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('repetitions must be a nonnegative safe integer that can be incremented');
  }
  if (!Number.isFinite(currentState.easeFactor) || currentState.easeFactor < MIN_EASE_FACTOR) {
    throw new RangeError('easeFactor must be finite and at least 1.3');
  }
  if (!Number.isSafeInteger(currentState.intervalDays) || currentState.intervalDays < 0) {
    throw new RangeError('intervalDays must be a nonnegative safe integer');
  }
  const quality = ratingToQuality(rating);
  const newEf = calculateEaseFactor(currentState.easeFactor, quality);

  const nextIntervalDays = calculateIntervalDays(
    quality,
    currentState.repetitions,
    currentState.intervalDays,
    newEf
  );

  const nextRepetitions = quality < 3 ? 0 : currentState.repetitions + 1;
  const dueAt = scheduledDate(reviewedAt, nextIntervalDays);

  return {
    repetitions: nextRepetitions,
    easeFactor: newEf,
    intervalDays: nextIntervalDays,
    dueAt,
    lastReviewedAt: new Date(reviewedAt),
  };
}
