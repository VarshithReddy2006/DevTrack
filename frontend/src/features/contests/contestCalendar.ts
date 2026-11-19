import { buildIcsContent, type UpcomingContest } from './contestsUtils';

export type CalendarMode = 'month' | 'week';
export type CalendarContest = { key: string; contest: UpcomingContest; start: number; end: number };
export type ContestCollisions = { count: number; keys: Set<string>; preview: [CalendarContest, CalendarContest][] };

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Calendar arithmetic, rather than 24-hour additions, preserves local DST days. */
export function calendarDays(anchor: Date, mode: CalendarMode): Date[] {
  if (!Number.isFinite(anchor.getTime())) throw new RangeError('Choose a valid calendar date.');
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), mode === 'month' ? 1 : anchor.getDate());
  const offset = (first.getDay() + 6) % 7;
  const count = mode === 'week' ? 7 : Math.ceil((offset + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7) * 7;
  return Array.from({ length: count }, (_, index) => new Date(first.getFullYear(), first.getMonth(), first.getDate() - offset + index));
}

export function calendarContests(contests: UpcomingContest[]): CalendarContest[] {
  const seen = new Set<string>();
  return contests.flatMap(contest => {
    const start = Date.parse(contest.startTime), end = Date.parse(contest.endTime);
    const key = `${contest.platform}:${contest.externalId}`;
    if (!['leetcode', 'codeforces', 'atcoder', 'codechef'].includes(contest.platform) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || seen.has(key)) return [];
    seen.add(key);
    return [{ key, contest, start, end }];
  }).sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}

export function contestsOnDay(contests: CalendarContest[], day: Date): CalendarContest[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  return contests.filter(contest => contest.start < end && contest.end > start);
}

/** Half-open intervals: an event ending at another's start does not collide. */
export function contestCollisions(contests: CalendarContest[]): ContestCollisions {
  const sorted = [...contests].sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
  let active: CalendarContest[] = [];
  const result: ContestCollisions = { count: 0, keys: new Set(), preview: [] };
  for (const current of sorted) {
    active = active.filter(event => event.end > current.start);
    for (const other of active) {
      result.count++; result.keys.add(other.key); result.keys.add(current.key);
      if (result.preview.length < 8) result.preview.push([other, current]);
    }
    active.push(current);
  }
  return result;
}

export function safeContestUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch { /* Invalid URLs remain visible as unavailable links, never executable hrefs. */ }
  return undefined;
}

export function contestReminderIcs(contest: UpcomingContest): string {
  return buildIcsContent([{ ...contest, url: safeContestUrl(contest.url) || '' }]).replace(
    '\r\nEND:VEVENT\r\n',
    '\r\nBEGIN:VALARM\r\nTRIGGER:-PT15M\r\nACTION:DISPLAY\r\nDESCRIPTION:Contest starts in 15 minutes\r\nEND:VALARM\r\nEND:VEVENT\r\n',
  );
}
