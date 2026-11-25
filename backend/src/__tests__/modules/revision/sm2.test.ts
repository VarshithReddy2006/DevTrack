// backend/src/__tests__/modules/revision/sm2.test.ts
import { describe, it, expect } from 'vitest';
import {
  computeNextSm2State,
  normalizeDueAt,
} from '../../../modules/revision/sm2.js';

describe('SM-2 due date calendar-day normalization', () => {
  describe('normalizeDueAt', () => {
    it.each([
      ['start of day', '2026-06-01T00:00:00.000Z', 1, '2026-06-02T00:00:00.000Z'],
      ['just after midnight', '2026-06-01T00:01:00.000Z', 1, '2026-06-02T00:00:00.000Z'],
      ['midday', '2026-06-01T12:00:00.000Z', 3, '2026-06-04T00:00:00.000Z'],
      ['late night', '2026-06-01T23:30:00.000Z', 1, '2026-06-02T00:00:00.000Z'],
      ['last millisecond of day', '2026-06-01T23:59:59.999Z', 7, '2026-06-08T00:00:00.000Z'],
      ['zero interval normalizes to current day start', '2026-06-01T18:45:12.345Z', 0, '2026-06-01T00:00:00.000Z'],
    ])('normalizes %s to 00:00:00.000Z on the target UTC day', (_label, iso, days, expectedIso) => {
      expect(normalizeDueAt(new Date(iso), days)).toEqual(new Date(expectedIso));
    });

    it('handles month, leap-year, and year boundaries cleanly', () => {
      expect(normalizeDueAt(new Date('2026-01-31T23:59:00.000Z'), 1)).toEqual(
        new Date('2026-02-01T00:00:00.000Z')
      );
      expect(normalizeDueAt(new Date('2026-02-28T23:59:00.000Z'), 1)).toEqual(
        new Date('2026-03-01T00:00:00.000Z')
      );
      expect(normalizeDueAt(new Date('2024-02-28T23:59:00.000Z'), 1)).toEqual(
        new Date('2024-02-29T00:00:00.000Z')
      );
      expect(normalizeDueAt(new Date('2024-02-28T23:59:00.000Z'), 2)).toEqual(
        new Date('2024-03-01T00:00:00.000Z')
      );
      expect(normalizeDueAt(new Date('2026-12-31T23:59:59.999Z'), 1)).toEqual(
        new Date('2027-01-01T00:00:00.000Z')
      );
    });

    it('preserves UTC stability across DST transition dates and non-UTC input offsets', () => {
      expect(normalizeDueAt(new Date('2026-03-08T23:30:00.000Z'), 1)).toEqual(
        new Date('2026-03-09T00:00:00.000Z')
      );
      expect(normalizeDueAt(new Date('2026-11-01T23:30:00.000Z'), 1)).toEqual(
        new Date('2026-11-02T00:00:00.000Z')
      );
      // 2026-06-01T23:30:00-05:00 corresponds to 2026-06-02T04:30:00.000Z in UTC
      expect(normalizeDueAt(new Date('2026-06-01T23:30:00-05:00'), 1)).toEqual(
        new Date('2026-06-03T00:00:00.000Z')
      );
    });

    it('throws RangeError for an invalid Date', () => {
      expect(() => normalizeDueAt(new Date('invalid'), 1)).toThrow(RangeError);
    });
  });

  describe('computeNextSm2State', () => {
    it('makes late-night reviews due at 00:00:00.000Z on the next calendar day', () => {
      const lateNight = new Date('2026-06-01T23:59:00.000Z');
      const next = computeNextSm2State(
        { repetitions: 0, easeFactor: 2.5, intervalDays: 1 },
        'easy',
        lateNight
      );

      expect(next.intervalDays).toBe(1);
      expect(next.dueAt).toEqual(new Date('2026-06-02T00:00:00.000Z'));
    });

    it('avoids cumulative time-of-day drift across repeated late-hour reviews', () => {
      let state = { repetitions: 0, easeFactor: 2.5, intervalDays: 1 };

      const review1 = computeNextSm2State(state, 'easy', new Date('2026-06-01T23:30:00.000Z'));
      expect(review1.intervalDays).toBe(1);
      expect(review1.dueAt).toEqual(new Date('2026-06-02T00:00:00.000Z'));

      // User opens queue next morning at 08:00 AM, then reviews again late at 23:50 PM
      state = {
        repetitions: review1.repetitions,
        easeFactor: review1.easeFactor,
        intervalDays: review1.intervalDays,
      };
      const review2 = computeNextSm2State(state, 'hard', new Date('2026-06-02T23:50:00.000Z'));
      expect(review2.intervalDays).toBe(3);
      expect(review2.dueAt).toEqual(new Date('2026-06-05T00:00:00.000Z'));

      state = {
        repetitions: review2.repetitions,
        easeFactor: review2.easeFactor,
        intervalDays: review2.intervalDays,
      };
      const review3 = computeNextSm2State(state, 'easy', new Date('2026-06-05T23:59:59.999Z'));
      expect(review3.intervalDays).toBe(7);
      expect(review3.dueAt).toEqual(new Date('2026-06-12T00:00:00.000Z'));
    });
  });
});
