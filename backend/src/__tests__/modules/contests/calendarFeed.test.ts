import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import { User } from '../../../db/models/user.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import {
  buildIcs,
  escapeText,
  findUserIdByCalendarToken,
  foldLine,
  formatIcsDate,
  getPreferredPlatforms,
  parsePlatformFilter,
  rotateCalendarToken,
} from '../../../modules/platform-sync/contests/calendarFeed.service.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');
const contest = (over: Record<string, unknown> = {}) => ({
  platform: 'codeforces' as const,
  externalId: '2050',
  contestName: 'Codeforces Round 999 (Div. 2)',
  startTime: new Date('2026-11-22T14:35:00.000Z'),
  endTime: new Date('2026-11-22T16:35:00.000Z'),
  url: 'https://codeforces.com/contests/2050',
  ...over,
});

describe('ics helpers', () => {
  it('formats UTC date-times without separators or millis', () => {
    expect(formatIcsDate(new Date('2026-11-22T14:35:07.123Z'))).toBe('20261122T143507Z');
  });

  it('escapes backslash, semicolon, comma and newlines', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const folded = foldLine('SUMMARY:' + 'é'.repeat(100));
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe('SUMMARY:' + 'é'.repeat(100));
  });

  it('validates the platform filter', () => {
    expect(parsePlatformFilter(undefined)).toHaveLength(4);
    expect(parsePlatformFilter('codeforces,atcoder')).toEqual(['codeforces', 'atcoder']);
    expect(parsePlatformFilter('nope')).toBeNull();
    expect(parsePlatformFilter('')).toBeNull();
    expect(parsePlatformFilter(['codeforces'])).toBeNull();
  });
});

describe('buildIcs', () => {
  it('produces a CRLF calendar with the required VEVENT fields and a 30 minute alarm', () => {
    const ics = buildIcs([contest()], NOW);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    for (const line of [
      'UID:codeforces-2050@devtrack',
      'DTSTAMP:20261120T100000Z',
      'DTSTART:20261122T143500Z',
      'DTEND:20261122T163500Z',
      'SUMMARY:[codeforces] Codeforces Round 999 (Div. 2)',
      'URL:https://codeforces.com/contests/2050',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT30M',
      'END:VALARM',
    ]) {
      expect(ics).toContain(line);
    }
    expect(ics).toMatch(/\r\nDESCRIPTION:/);
  });

  it('balances BEGIN/END and keeps one event per contest', () => {
    const ics = buildIcs([contest(), contest({ externalId: '2051', platform: 'leetcode' })], NOW);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/END:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(ics).toContain('UID:leetcode-2051@devtrack');
  });

  it('returns an empty but valid calendar for no contests', () => {
    const ics = buildIcs([], NOW);
    expect(ics).not.toContain('BEGIN:VEVENT');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('escapes special characters in the contest name', () => {
    const ics = buildIcs([contest({ contestName: 'Round; 1, "Final"' })], NOW);
    expect(ics).toContain('SUMMARY:[codeforces] Round\\; 1\\, "Final"');
  });

  it('skips contests with invalid dates', () => {
    const ics = buildIcs([contest({ startTime: new Date('nope') })], NOW);
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});

describe('calendar feed token', () => {
  beforeAll(async () => {
    await Promise.all([User.init(), UserSettings.init()]);
  });

  async function makeUser() {
    const n = new Types.ObjectId().toString();
    return User.create({ clerkId: `clerk_${n}`, email: `${n}@example.com`, username: `u${n.slice(0, 12)}`, displayName: 'T' });
  }

  it('authenticates with the issued token and stores only a hash', async () => {
    const user = await makeUser();
    const token = await rotateCalendarToken(user.id);
    expect(await findUserIdByCalendarToken(token)).toBe(user.id);
    const stored = await User.findById(user.id).select('+calendarTokenHash').lean();
    expect(stored?.calendarTokenHash).toBeTruthy();
    expect(stored?.calendarTokenHash).not.toBe(token);
  });

  it('invalidates the old token when rotated', async () => {
    const user = await makeUser();
    const first = await rotateCalendarToken(user.id);
    const second = await rotateCalendarToken(user.id);
    expect(await findUserIdByCalendarToken(first)).toBeNull();
    expect(await findUserIdByCalendarToken(second)).toBe(user.id);
  });

  it('rejects missing, malformed and unknown tokens', async () => {
    expect(await findUserIdByCalendarToken(undefined)).toBeNull();
    expect(await findUserIdByCalendarToken('short')).toBeNull();
    expect(await findUserIdByCalendarToken({ $ne: null })).toBeNull();
    expect(await findUserIdByCalendarToken('a'.repeat(48))).toBeNull();
  });

  it('uses linked platforms as preferences and falls back to all', async () => {
    const withHandle = new Types.ObjectId();
    await UserSettings.create({ userId: withHandle, platforms: { codeforces: { handle: 'tourist' } } });
    expect(await getPreferredPlatforms(withHandle.toString())).toEqual(['codeforces']);
    expect(await getPreferredPlatforms(new Types.ObjectId().toString())).toHaveLength(4);
  });
});
