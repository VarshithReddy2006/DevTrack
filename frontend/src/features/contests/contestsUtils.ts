export type ContestPlatform = 'leetcode' | 'codeforces' | 'atcoder' | 'codechef';

export interface UpcomingContest {
  platform: ContestPlatform;
  externalId: string;
  contestName: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  url: string;
  phase: string;
  kind: 'scheduled';
  stale?: boolean;
  fetchedAt?: string | null;
}

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  state: 'upcoming' | 'live' | 'ended';
}

export function getCountdownParts(
  startTime: string | Date,
  endTime: string | Date,
  now = Date.now()
): CountdownParts {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, state: 'ended' };
  }
  if (now >= end) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, state: 'ended' };
  }
  if (now >= start) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, state: 'live' };
  }

  let remaining = Math.floor((start - now) / 1000);
  const days = Math.floor(remaining / 86400);
  remaining %= 86400;
  const hours = Math.floor(remaining / 3600);
  remaining %= 3600;
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  return { days, hours, minutes, seconds, state: 'upcoming' };
}

export function buildGoogleCalendarUrl(contest: UpcomingContest): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: contest.contestName,
    dates: `${formatGoogleDate(contest.startTime)}/${formatGoogleDate(contest.endTime)}`,
    details: `${contest.platform} contest.\nContest link: ${contest.url}`,
    location: contest.url,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function formatGoogleDate(value: string | Date): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function formatIcsDate(value: string | Date): string {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function foldIcsLine(line: string): string {
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;

  for (const character of line) {
    const characterBytes = new TextEncoder().encode(character).length;
    if (bytes + characterBytes > 73) {
      chunks.push(current);
      current = character;
      bytes = characterBytes;
    } else {
      current += character;
      bytes += characterBytes;
    }
  }

  if (current) chunks.push(current);
  return chunks.join('\r\n ');
}

export function buildIcsContent(contests: UpcomingContest[], now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//DevTrack//Contest Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const contest of contests) {
    const start = new Date(contest.startTime);
    const end = new Date(contest.endTime);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) continue;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(contest.externalId)}-${contest.platform}@devtrack`,
      `DTSTAMP:${formatIcsDate(now)}`,
      `DTSTART:${formatIcsDate(start)}`,
      `DTEND:${formatIcsDate(end)}`,
      `SUMMARY:${escapeIcsText(contest.contestName)}`,
      `DESCRIPTION:${escapeIcsText(`${contest.platform} contest. ${contest.url}`)}`,
      `URL:${contest.url}`,
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}
