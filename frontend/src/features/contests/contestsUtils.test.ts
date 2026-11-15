import { describe, expect, it } from 'vitest';
import {
  buildGoogleCalendarUrl,
  buildIcsContent,
  getCountdownParts,
  type UpcomingContest,
} from './contestsUtils';

const contest: UpcomingContest = {
  platform: 'codeforces',
  externalId: 'round-1',
  contestName: 'Round 1; Practice, Finals',
  startTime: '2026-12-01T10:00:00.000Z',
  endTime: '2026-12-01T12:00:00.000Z',
  durationSeconds: 7200,
  url: 'https://codeforces.com/contest/1',
  phase: 'BEFORE',
  kind: 'scheduled',
};

describe('contest calendar utilities', () => {
  it('builds a Google Calendar template URL with contest details and UTC dates', () => {
    const url = new URL(buildGoogleCalendarUrl(contest));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe(contest.contestName);
    expect(url.searchParams.get('dates')).toBe('20261201T100000Z/20261201T120000Z');
    expect(url.searchParams.get('details')).toContain(contest.url);
  });

  it('creates an RFC 5545 calendar with escaped event text', () => {
    const content = buildIcsContent([contest], new Date('2026-11-15T00:00:00.000Z'));
    expect(content).toContain('BEGIN:VCALENDAR\r\n');
    expect(content).toContain('BEGIN:VEVENT\r\n');
    expect(content).toContain('SUMMARY:Round 1\\; Practice\\, Finals');
    expect(content).toContain('DTSTART:20261201T100000Z');
    expect(content).toContain('URL:https://codeforces.com/contest/1');
    expect(content).toContain('END:VCALENDAR\r\n');
  });

  it('calculates days, hours, minutes and seconds until a contest starts', () => {
    expect(getCountdownParts(contest.startTime, contest.endTime, Date.parse('2026-11-29T08:30:15.000Z'))).toEqual({
      days: 2, hours: 1, minutes: 29, seconds: 45, state: 'upcoming',
    });
  });

  it('reports live and ended contest states', () => {
    expect(getCountdownParts(contest.startTime, contest.endTime, Date.parse('2026-12-01T11:00:00.000Z')).state).toBe('live');
    expect(getCountdownParts(contest.startTime, contest.endTime, Date.parse('2026-12-01T12:00:00.000Z')).state).toBe('ended');
  });

  it('omits events with invalid or non-positive durations', () => {
    const invalid = { ...contest, endTime: contest.startTime };
    expect(buildIcsContent([invalid])).not.toContain('BEGIN:VEVENT');
  });
});
