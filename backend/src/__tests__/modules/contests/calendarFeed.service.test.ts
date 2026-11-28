import { describe, expect, it } from 'vitest';
import {
  buildIcs,
  escapeText,
  parseContestDate,
} from '../../../modules/platform-sync/contests/calendarFeed.service.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');
type Contest = Parameters<typeof buildIcs>[0][number];

const contest = (over: Record<string, unknown> = {}): Contest =>
  ({
    platform: 'codeforces',
    externalId: '2050',
    contestName: 'Weekend Hackathon',
    startTime: new Date('2026-11-22T14:35:00.000Z'),
    endTime: new Date('2026-11-22T16:35:00.000Z'),
    url: 'https://codeforces.com/contests/2050',
    ...over,
  }) as Contest;

/** Unfolds the feed and returns the properties of each VEVENT, ignoring nested alarms. */
function parseEvents(ics: string): Array<Record<string, string>> {
  const events: Array<Record<string, string>> = [];
  const stack: string[] = [];
  for (const line of ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean)) {
    const colon = line.indexOf(':');
    expect(colon).toBeGreaterThan(0);
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (name === 'BEGIN') {
      stack.push(value);
      if (value === 'VEVENT') events.push({});
    } else if (name === 'END') {
      expect(stack.pop()).toBe(value);
    } else if (stack.at(-1) === 'VEVENT') {
      events.at(-1)![name] = value;
    }
  }
  expect(stack).toEqual([]);
  return events;
}

describe('calendar feed date boundaries', () => {
  it.each([
    ['a month', '2026-10-31T18:00:00Z', '2026-11-02T18:00:00Z', '20261031T180000Z', '20261102T180000Z'],
    ['January into February', '2027-01-31T00:00:00Z', '2027-02-02T00:00:00Z', '20270131T000000Z', '20270202T000000Z'],
    ['a year', '2026-12-31T22:00:00Z', '2027-01-02T01:30:00Z', '20261231T220000Z', '20270102T013000Z'],
    ['a leap day', '2028-02-28T12:00:00Z', '2028-02-29T12:00:00Z', '20280228T120000Z', '20280229T120000Z'],
  ])('keeps exact start and end across %s', (_label, from, to, dtstart, dtend) => {
    const [event] = parseEvents(buildIcs([contest({ startTime: new Date(from), endTime: new Date(to) })], NOW));
    expect(event).toMatchObject({ DTSTART: dtstart, DTEND: dtend });
  });

  it('converts explicit offsets to UTC, including across a month boundary', () => {
    const [event] = parseEvents(
      buildIcs([contest({ startTime: '2026-11-01T01:00:00+05:30', endTime: '2026-11-01T03:00:00-04:00' })], NOW)
    );
    expect(event).toMatchObject({ DTSTART: '20261031T193000Z', DTEND: '20261101T070000Z' });
  });

  it('reads zoneless strings as UTC whatever the server timezone is', () => {
    expect(parseContestDate('2026-11-22T14:35:00')?.toISOString()).toBe('2026-11-22T14:35:00.000Z');
    expect(parseContestDate('2026-11-22 14:35')?.toISOString()).toBe('2026-11-22T14:35:00.000Z');
  });

  it('rejects missing, invalid and unrepresentable values', () => {
    for (const bad of [null, undefined, '', 'soon', '2026-11-22T14:35:00+99:00', new Date('+010000-01-01')]) {
      expect(parseContestDate(bad)).toBeNull();
    }
  });
});

describe('calendar feed events without a usable end', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['invalid', 'tbd'],
    ['equal to the start', new Date('2026-11-22T14:35:00.000Z')],
    ['before the start', new Date('2026-11-21T00:00:00.000Z')],
  ])('omits DTEND when the end is %s', (_label, endTime) => {
    const [event] = parseEvents(buildIcs([contest({ endTime })], NOW));
    expect(event.DTSTART).toBe('20261122T143500Z');
    expect(event.DTEND).toBeUndefined();
  });

  it('skips an event with no start instead of dating it 1970', () => {
    expect(parseEvents(buildIcs([contest({ startTime: null })], NOW))).toEqual([]);
  });
});

describe('calendar feed text and identifiers', () => {
  it('emits one event per UID', () => {
    const events = parseEvents(buildIcs([contest(), contest({ contestName: 'Copy' })], NOW));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ UID: 'codeforces-2050@devtrack', SUMMARY: '[codeforces] Weekend Hackathon' });
  });

  it('escapes separators and newlines and drops control characters', () => {
    expect(escapeText('a,b;c\r\nd\u0000\u000Be\tf')).toBe('a\\,b\\;c\\nde\tf');
  });

  it('does not let a URL or id add lines to the feed', () => {
    const ics = buildIcs(
      [contest({ externalId: '1\r\nSUMMARY:x', url: 'https://example.com/a\r\nATTENDEE:mailto:x@example.com' })],
      NOW
    );
    expect(ics).not.toMatch(/\r\nATTENDEE/);
    expect(ics).not.toMatch(/\r\nSUMMARY:x/);
    expect(parseEvents(ics)).toHaveLength(1);
  });

  it('leaves out a URL that is not http or https', () => {
    const [event] = parseEvents(buildIcs([contest({ url: 'javascript:alert(1)' })], NOW));
    expect(event.URL).toBeUndefined();
    expect(event.DESCRIPTION).toBe('Weekend Hackathon on codeforces.');
  });
});
