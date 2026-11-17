import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  divisionLabel,
  formatPoints,
  getCountdownParts,
  loadRankSnapshot,
  memberName,
  rankChange,
  saveRankSnapshot,
  toRankSnapshot,
  zoneForRank,
} from '../leagueUtils';
import { makeCohort } from './fixtures';

describe('zoneForRank', () => {
  it('splits a 30 player cohort into 6 / 18 / 6', () => {
    const zones = Array.from({ length: 30 }, (_, i) => zoneForRank(i + 1, 30, 6, 6));
    expect(zones.filter((z) => z === 'promotion')).toHaveLength(6);
    expect(zones.filter((z) => z === 'demotion')).toHaveLength(6);
    expect(zones[5]).toBe('promotion');
    expect(zones[6]).toBe('safe');
    expect(zones[23]).toBe('safe');
    expect(zones[24]).toBe('demotion');
  });

  it('has no zones when the API reports zero slots', () => {
    expect(zoneForRank(1, 4, 0, 0)).toBe('safe');
    expect(zoneForRank(4, 4, 0, 0)).toBe('safe');
  });
});

describe('getCountdownParts', () => {
  it('breaks the remaining time into days, hours and minutes', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const target = now + ((2 * 24 + 3) * 60 + 4) * 60_000 + 59_999;
    expect(getCountdownParts(target, now)).toEqual({ days: 2, hours: 3, minutes: 4, ended: false });
  });

  it('is ended at zero, in the past and for a bad date', () => {
    expect(getCountdownParts(1000, 1000).ended).toBe(true);
    expect(getCountdownParts(500, 1000).ended).toBe(true);
    expect(getCountdownParts(Number.NaN, 1000).ended).toBe(true);
  });
});

describe('labels and formatting', () => {
  it('names divisions and members', () => {
    expect(divisionLabel('grandmaster')).toBe('Grandmaster');
    expect(divisionLabel(null)).toBe('Unranked');
    expect(memberName({ displayName: '  Ada ', username: 'ada' })).toBe('Ada');
    expect(memberName({ displayName: ' ', username: 'ada' })).toBe('ada');
    expect(memberName({ displayName: null, username: null })).toBe('Anonymous');
  });

  it('formats points with thousands separators', () => {
    expect(formatPoints(1234567)).toBe('1,234,567');
  });
});

describe('rank changes', () => {
  const [first] = makeCohort(3, 1);

  it('is positive for a gain, negative for a drop and null without history', () => {
    expect(rankChange({ [first.userId]: 4 }, first)).toBe(3);
    expect(rankChange({ [first.userId]: 1 }, first)).toBe(0);
    expect(rankChange({ [first.userId]: 1 }, { ...first, rank: 5 })).toBe(-4);
    expect(rankChange({}, first)).toBeNull();
    expect(rankChange(null, first)).toBeNull();
  });

  it('turns standings into a userId -> rank map', () => {
    expect(toRankSnapshot(makeCohort(3, 1))).toEqual({ 'user-1': 1, 'user-2': 2, 'user-3': 3 });
  });
});

describe('rank snapshot storage', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round trips per week and cohort', () => {
    saveRankSnapshot('2026-W47', 'c1', { a: 1 });
    expect(loadRankSnapshot('2026-W47', 'c1')).toEqual({ a: 1 });
    expect(loadRankSnapshot('2026-W47', 'c2')).toBeNull();
    expect(loadRankSnapshot('2026-W48', 'c1')).toBeNull();
  });

  it('ignores corrupt stored data', () => {
    localStorage.setItem('devtrack:leagues:ranks:w:c', '{not json');
    expect(loadRankSnapshot('w', 'c')).toBeNull();
    localStorage.setItem('devtrack:leagues:ranks:w:c', '[1,2]');
    expect(loadRankSnapshot('w', 'c')).toBeNull();
    localStorage.setItem('devtrack:leagues:ranks:w:c', '{"a":"first"}');
    expect(loadRankSnapshot('w', 'c')).toBeNull();
  });

  it('does not throw when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => saveRankSnapshot('w', 'c', { a: 1 })).not.toThrow();
    expect(loadRankSnapshot('w', 'c')).toBeNull();
  });
});
