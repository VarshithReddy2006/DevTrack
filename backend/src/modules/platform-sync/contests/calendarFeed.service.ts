import { createHash, randomBytes } from 'node:crypto';
import { User } from '../../../db/models/user.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import type { ContestPlatform, UpcomingContest } from './ContestSource.js';

const CRLF = '\r\n';
const PRODID = '-//DevTrack//Contest Hub//EN';
const ALL_PLATFORMS: ContestPlatform[] = ['codeforces', 'leetcode', 'atcoder', 'codechef'];

type CalendarContest = Pick<
  UpcomingContest,
  'platform' | 'externalId' | 'contestName' | 'startTime' | 'endTime' | 'url'
>;

// Control characters that RFC 5545 does not allow in a content line (tab and line breaks are handled apart).
const FORBIDDEN_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Escape a TEXT value per RFC 5545 section 3.3.11. */
export function escapeText(value: string): string {
  return value
    .replace(FORBIDDEN_CONTROLS, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line at 75 octets, continuation lines start with one space. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  let limit = 75;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
      limit = 74; // the leading space counts toward the 75 octets
    }
    current += ch;
    size += bytes;
  }
  parts.push(current);
  return parts.join(CRLF + ' ');
}

/** UTC date-time, e.g. 20261120T093000Z. */
export function formatIcsDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// An ISO date-time with no zone designator, which `new Date` would read in the server's local time.
const ZONELESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Reads a contest timestamp (a Date, or a string once it has been through the Redis cache).
 * Zoneless strings are taken as UTC. Returns null for anything missing, invalid or outside
 * the four-digit years that RFC 5545 can express.
 */
export function parseContestDate(value: unknown): Date | null {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    const text = value.trim();
    date = new Date(ZONELESS_DATE_TIME.test(text) ? `${text.replace(' ', 'T')}Z` : text);
  } else {
    return null;
  }
  const year = date.getUTCFullYear();
  return year >= 1 && year <= 9999 ? date : null;
}

/** The URL in its normalised http(s) form, or null. It can never carry a line break into the feed. */
function feedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function buildIcs(contests: CalendarContest[], now: Date = new Date(), calendarName = 'DevTrack Contests'): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];

  const seen = new Set<string>();

  for (const c of contests) {
    const start = parseContestDate(c.startTime);
    if (!start) continue;

    // A repeated UID shows up as a ghost event in calendar apps, so the first copy wins.
    const uid = escapeText(`${c.platform}-${c.externalId}@devtrack`);
    if (seen.has(uid)) continue;
    seen.add(uid);

    // DTEND is optional but must be later than DTSTART, so leave it out when the end is unknown.
    const end = parseContestDate(c.endTime);
    const dtstart = formatIcsDate(start);
    const dtend = end ? formatIcsDate(end) : null;
    const url = feedUrl(c.url);
    const description = `${c.contestName} on ${c.platform}.${url ? ` ${url}` : ''}`;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${formatIcsDate(now)}`,
      `DTSTART:${dtstart}`,
      ...(dtend && dtend > dtstart ? [`DTEND:${dtend}`] : []),
      `SUMMARY:${escapeText(`[${c.platform}] ${c.contestName}`)}`,
      `DESCRIPTION:${escapeText(description)}`,
      ...(url ? [`URL:${url}`] : []),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(`${c.contestName} starts in 30 minutes`)}`,
      'TRIGGER:-PT30M',
      'END:VALARM',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}

export function hashCalendarToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Create a new feed token for the user, replacing any previous one. The plain token is returned once. */
export async function rotateCalendarToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString('hex');
  await User.updateOne({ _id: userId }, { $set: { calendarTokenHash: hashCalendarToken(token) } });
  return token;
}

export async function findUserIdByCalendarToken(token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const user = await User.findOne({ calendarTokenHash: hashCalendarToken(token) }).select('_id').lean();
  return user ? String(user._id) : null;
}

/** Platforms the user has linked a handle for; falls back to every platform if none are linked. */
export async function getPreferredPlatforms(userId: string): Promise<ContestPlatform[]> {
  const settings = await UserSettings.findOne({ userId }).select('platforms').lean();
  const platforms = settings?.platforms as Record<string, { handle?: string; username?: string }> | undefined;
  const linked = ALL_PLATFORMS.filter((p) => {
    const entry = platforms?.[p];
    return Boolean(entry?.handle || entry?.username);
  });
  return linked.length > 0 ? linked : ALL_PLATFORMS;
}

export function parsePlatformFilter(raw: unknown): ContestPlatform[] | null {
  if (raw === undefined) return ALL_PLATFORMS;
  if (typeof raw !== 'string') return null;
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0 || wanted.some((p) => !ALL_PLATFORMS.includes(p as ContestPlatform))) return null;
  return wanted as ContestPlatform[];
}
