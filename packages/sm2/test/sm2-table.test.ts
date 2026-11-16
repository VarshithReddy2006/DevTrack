import { describe, it, expect } from 'vitest';
import {
  nextState,
  createInitialSm2State,
  calculateEaseFactor,
  calculateIntervalDays,
  ratingToQuality,
  MIN_EASE_FACTOR,
  INITIAL_EASE_FACTOR,
  DAY_IN_MS,
  type Sm2Rating,
  type Sm2State,
} from '../src/index.js';

describe('SuperMemo-2 (SM-2) Pure Engine (@devtrack/sm2)', () => {
  const baseTime = new Date('2026-01-01T12:00:00.000Z');

  describe('Rating to Quality Score Mapping', () => {
    it('maps ratings to canonical SM-2 quality scores', () => {
      expect(ratingToQuality('failed')).toBe(1);
      expect(ratingToQuality('hard')).toBe(3);
      expect(ratingToQuality('easy')).toBe(5);
    });
  });

  describe('Ease Factor Mathematical Growth & Limits', () => {
    it('increases EF by 0.1 on perfect recall (easy, q=5)', () => {
      const newEf = calculateEaseFactor(2.5, 5);
      expect(newEf).toBe(2.6);
    });

    it('decreases EF by 0.14 on difficult solve (hard, q=3)', () => {
      const newEf = calculateEaseFactor(2.5, 3);
      expect(newEf).toBe(2.36);
    });

    it('decreases EF by 0.54 on blackout failure (failed, q=1)', () => {
      const newEf = calculateEaseFactor(2.5, 1);
      expect(newEf).toBe(1.96);
    });

    it('strictly clamps EF at minimum floor of 1.30 across repeated failures', () => {
      let ef = 1.5;
      ef = calculateEaseFactor(ef, 1); // 1.5 - 0.54 = 0.96 -> clamped to 1.30
      expect(ef).toBe(MIN_EASE_FACTOR);

      ef = calculateEaseFactor(ef, 1); // repeated failure
      expect(ef).toBe(1.3);
    });
  });

  describe('Interval Calculations', () => {
    it('resets interval to 1 day on failed reviews (q < 3)', () => {
      expect(calculateIntervalDays(1, 0, 1, 2.5)).toBe(1);
      expect(calculateIntervalDays(1, 5, 60, 2.8)).toBe(1);
    });

    it('follows standard 1 -> 3 -> 7 day seed progression for initial successful repetitions', () => {
      expect(calculateIntervalDays(5, 0, 1, 2.5)).toBe(1);
      expect(calculateIntervalDays(5, 1, 1, 2.6)).toBe(3);
      expect(calculateIntervalDays(5, 2, 3, 2.7)).toBe(7);
    });

    it('scales multiplicatively by EF for repetitions > 2', () => {
      // Repetition 3 with previous interval 7 and EF 2.8 -> round(7 * 2.8) = 20
      expect(calculateIntervalDays(5, 3, 7, 2.8)).toBe(20);
      // Repetition 4 with previous interval 20 and EF 2.9 -> round(20 * 2.9) = 58
      expect(calculateIntervalDays(5, 4, 20, 2.9)).toBe(58);
    });
  });

  describe('Golden Table State Transitions (nextState)', () => {
    it('progresses through a multi-stage successful review sequence', () => {
      let state = createInitialSm2State(baseTime);
      expect(state.repetitions).toBe(0);
      expect(state.easeFactor).toBe(INITIAL_EASE_FACTOR);
      expect(state.intervalDays).toBe(1);

      // Review 1: Easy
      const t1 = new Date('2026-01-02T12:00:00.000Z');
      state = nextState(state, 'easy', t1);
      expect(state.repetitions).toBe(1);
      expect(state.easeFactor).toBe(2.6);
      expect(state.intervalDays).toBe(1);
      expect(state.dueAt).toEqual(new Date(t1.getTime() + 1 * 86_400_000));
      expect(state.lastReviewedAt).toEqual(t1);

      // Review 2: Easy
      const t2 = new Date('2026-01-03T12:00:00.000Z');
      state = nextState(state, 'easy', t2);
      expect(state.repetitions).toBe(2);
      expect(state.easeFactor).toBe(2.7);
      expect(state.intervalDays).toBe(3);
      expect(state.dueAt).toEqual(new Date(t2.getTime() + 3 * 86_400_000));

      // Review 3: Easy
      const t3 = new Date('2026-01-06T12:00:00.000Z');
      state = nextState(state, 'easy', t3);
      expect(state.repetitions).toBe(3);
      expect(state.easeFactor).toBe(2.8);
      expect(state.intervalDays).toBe(7);
      expect(state.dueAt).toEqual(new Date(t3.getTime() + 7 * 86_400_000));

      // Review 4: Easy -> round(7 * 2.9) = 20 days
      const t4 = new Date('2026-01-13T12:00:00.000Z');
      state = nextState(state, 'easy', t4);
      expect(state.repetitions).toBe(4);
      expect(state.easeFactor).toBe(2.9);
      expect(state.intervalDays).toBe(20);
      expect(state.dueAt).toEqual(new Date(t4.getTime() + 20 * 86_400_000));
    });

    it('handles failure lapse and recovers cleanly', () => {
      // Start card with established interval
      const matureState: Sm2State = {
        repetitions: 4,
        easeFactor: 2.8,
        intervalDays: 20,
        dueAt: baseTime,
        lastReviewedAt: new Date(baseTime.getTime() - 20 * 86_400_000),
      };

      // Review: Failed
      const failedState = nextState(matureState, 'failed', baseTime);
      expect(failedState.repetitions).toBe(0);
      expect(failedState.intervalDays).toBe(1);
      expect(failedState.easeFactor).toBe(2.26); // 2.8 - 0.54
      expect(failedState.dueAt).toEqual(new Date(baseTime.getTime() + 1 * 86_400_000));

      // Re-review next day: Hard
      const nextDay = new Date(baseTime.getTime() + 86_400_000);
      const recoveredState = nextState(failedState, 'hard', nextDay);
      expect(recoveredState.repetitions).toBe(1);
      expect(recoveredState.intervalDays).toBe(1); // Repetition 0 -> 1 day
      expect(recoveredState.easeFactor).toBe(2.12); // 2.26 - 0.14
    });

    it('adapts when developer rates problem as hard repeatedly', () => {
      let state = createInitialSm2State(baseTime);

      // 3 consecutive hard ratings
      state = nextState(state, 'hard', baseTime);
      expect(state.repetitions).toBe(1);
      expect(state.easeFactor).toBe(2.36);
      expect(state.intervalDays).toBe(1);

      state = nextState(state, 'hard', baseTime);
      expect(state.repetitions).toBe(2);
      expect(state.easeFactor).toBe(2.22);
      expect(state.intervalDays).toBe(3);

      state = nextState(state, 'hard', baseTime);
      expect(state.repetitions).toBe(3);
      expect(state.easeFactor).toBe(2.08);
      expect(state.intervalDays).toBe(7);

      // 4th review: round(7 * 1.94) = 14 days
      state = nextState(state, 'hard', baseTime);
      expect(state.repetitions).toBe(4);
      expect(state.easeFactor).toBe(1.94);
      expect(state.intervalDays).toBe(14);
    });
  });
});

describe('SM-2 boundary and long-running contracts', () => {
  const start = new Date('2024-02-28T12:34:56.789Z');

  it('matches an explicit multi-year easy sequence using the updated EF', () => {
    const golden = [
      [1, 2.6, 1], [2, 2.7, 3], [3, 2.8, 7], [4, 2.9, 20],
      [5, 3.0, 60], [6, 3.1, 186], [7, 3.2, 595], [8, 3.3, 1964],
    ];
    let state = createInitialSm2State(start);
    for (const [repetitions, easeFactor, intervalDays] of golden) {
      const now = state.dueAt;
      state = nextState(state, 'easy', now);
      expect([state.repetitions, state.easeFactor, state.intervalDays])
        .toEqual([repetitions, easeFactor, intervalDays]);
      expect(state.dueAt.getTime() - now.getTime()).toBe(intervalDays * DAY_IN_MS);
    }
    expect(state.dueAt.getUTCFullYear()).toBeGreaterThanOrEqual(2031);
  });

  it('reaches the EF floor on hard reviews and recovers through a lapse', () => {
    const ratings: Sm2Rating[] = [
      'hard', 'hard', 'hard', 'hard', 'hard', 'hard', 'hard', 'hard', 'hard',
      'failed', 'failed', 'easy', 'hard', 'easy', 'easy',
    ];
    const golden = [
      [1, 2.36, 1], [2, 2.22, 3], [3, 2.08, 7], [4, 1.94, 14],
      [5, 1.8, 25], [6, 1.66, 42], [7, 1.52, 64], [8, 1.38, 88],
      [9, 1.3, 114], [0, 1.3, 1], [0, 1.3, 1], [1, 1.4, 1],
      [2, 1.3, 3], [3, 1.4, 7], [4, 1.5, 11],
    ];
    let state = createInitialSm2State(start);
    ratings.forEach((rating, index) => {
      state = nextState(state, rating, state.dueAt);
      expect([state.repetitions, state.easeFactor, state.intervalDays]).toEqual(golden[index]);
    });
  });

  it('does not mutate inputs or retain caller-owned Date references', () => {
    const now = new Date(start);
    const initial = createInitialSm2State(now);
    const before = structuredClone(initial);
    Object.freeze(initial);
    const next = nextState(initial, 'easy', now);
    expect(initial).toEqual(before);
    now.setTime(0);
    expect(initial.lastReviewedAt).toEqual(start);
    expect(next.lastReviewedAt).toEqual(start);
    next.lastReviewedAt.setTime(1);
    expect(initial.lastReviewedAt).toEqual(start);
  });

  it.each([
    '2024-02-28T23:30:00.000Z', // leap day
    '2026-03-08T06:30:00.000Z', // US spring DST boundary
    '2026-11-01T05:30:00.000Z', // US autumn DST boundary
    '2026-12-31T23:59:59.999Z', // year boundary
  ])('uses exactly 24 hours per day at %s', (iso) => {
    const now = new Date(iso);
    const next = nextState(createInitialSm2State(now), 'failed', now);
    expect(next.dueAt.getTime()).toBe(now.getTime() + DAY_IN_MS);
  });

  it.each([
    { repetitions: -1 }, { repetitions: 0.5 }, { repetitions: Number.MAX_SAFE_INTEGER },
    { easeFactor: NaN }, { easeFactor: Infinity }, { easeFactor: 1.29 },
    { intervalDays: -1 }, { intervalDays: 1.5 }, { intervalDays: Infinity },
  ])('rejects invalid persisted scheduling fields %j', (invalid) => {
    expect(() => nextState({ ...createInitialSm2State(start), ...invalid }, 'easy', start))
      .toThrow(RangeError);
  });

  it('rejects invalid dates, ratings and schedules outside the Date range', () => {
    const state = createInitialSm2State(start);
    expect(() => createInitialSm2State(new Date(NaN))).toThrow(RangeError);
    expect(() => nextState(state, 'easy', new Date(NaN))).toThrow(RangeError);
    expect(() => nextState(state, 'unknown' as Sm2Rating, start)).toThrow(RangeError);
    expect(() => createInitialSm2State(new Date(8.64e15))).toThrow(RangeError);
    expect(() => nextState({ ...state, repetitions: 4, intervalDays: 100_000_000 }, 'easy', start))
      .toThrow(RangeError);
  });
});
