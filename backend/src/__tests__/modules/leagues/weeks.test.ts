import { describe, expect, it } from 'vitest';
import { isValidWeekKey, nextWeekKey, previousWeekKey, secondsUntilReset, weekKeyFor, weekRange } from '../../../modules/leagues/weeks.js';

describe('league weeks (Sunday 00:00 UTC)', () => {
  it('starts a new week exactly at Sunday 00:00 UTC', () => {
    expect(weekKeyFor(new Date('2026-11-14T23:59:59.999Z'))).toBe('2026-11-08'); // Saturday
    expect(weekKeyFor(new Date('2026-11-15T00:00:00.000Z'))).toBe('2026-11-15'); // Sunday
    expect(weekKeyFor(new Date('2026-11-18T10:00:00Z'))).toBe('2026-11-15');
  });

  it('does not depend on the server time zone: a late Saturday offset time is still the old week', () => {
    expect(weekKeyFor(new Date('2026-11-14T20:00:00-05:00'))).toBe('2026-11-15');
    expect(weekKeyFor(new Date('2026-11-15T03:00:00+05:30'))).toBe('2026-11-08');
  });

  it('gives a half-open range of 7 days', () => {
    const { start, end } = weekRange('2026-11-15');
    expect(start.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-22T00:00:00.000Z');
  });

  it('walks across month and year boundaries', () => {
    expect(nextWeekKey('2026-12-27')).toBe('2027-01-03');
    expect(previousWeekKey('2027-01-03')).toBe('2026-12-27');
  });

  it('validates week keys', () => {
    expect(isValidWeekKey('2026-11-15')).toBe(true);
    expect(isValidWeekKey('2026-11-16')).toBe(false); // a Monday
    expect(isValidWeekKey('2026-02-30')).toBe(false);
    expect(isValidWeekKey('2026-W46')).toBe(false);
    expect(() => weekRange('2026-11-16')).toThrow(/Invalid league week key/);
  });

  it('counts down to the next reset', () => {
    expect(secondsUntilReset(new Date('2026-11-21T23:59:00Z'))).toBe(60);
    expect(secondsUntilReset(new Date('2026-11-15T00:00:00Z'))).toBe(7 * 86400);
  });
});
