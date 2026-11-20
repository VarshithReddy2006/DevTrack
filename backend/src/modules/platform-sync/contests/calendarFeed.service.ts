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

/** Escape a TEXT value per RFC 5545 section 3.3.11. */
export function escapeText(value: string): string {
  return value
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

export function buildIcs(contests: CalendarContest[], now: Date = new Date(), calendarName = 'DevTrack Contests'): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];

  for (const c of contests) {
    const start = new Date(c.startTime);
    const end = new Date(c.endTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${c.platform}-${c.externalId}@devtrack`,
      `DTSTAMP:${formatIcsDate(now)}`,
      `DTSTART:${formatIcsDate(start)}`,
      `DTEND:${formatIcsDate(end)}`,
      `SUMMARY:${escapeText(`[${c.platform}] ${c.contestName}`)}`,
      `DESCRIPTION:${escapeText(`${c.contestName} on ${c.platform}. ${c.url}`)}`,
      `URL:${c.url}`,
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
