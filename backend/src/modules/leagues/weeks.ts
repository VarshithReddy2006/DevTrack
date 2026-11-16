// src/modules/leagues/weeks.ts — League weeks run Sunday 00:00 UTC to the next Sunday 00:00 UTC.
// A week is identified by the UTC date of the Sunday that starts it (e.g. "2026-11-15").

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const WEEK_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function weekStart(date: Date): Date {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return new Date(midnight - date.getUTCDay() * DAY_MS);
}

export function weekKeyFor(date: Date): string {
  return weekStart(date).toISOString().slice(0, 10);
}

export function isValidWeekKey(weekKey: string): boolean {
  const match = WEEK_KEY_RE.exec(weekKey);
  if (!match) return false;
  const start = new Date(`${weekKey}T00:00:00.000Z`);
  return !Number.isNaN(start.getTime()) && start.toISOString().slice(0, 10) === weekKey && start.getUTCDay() === 0;
}

function assertWeekKey(weekKey: string): Date {
  if (!isValidWeekKey(weekKey)) throw new Error(`Invalid league week key: ${weekKey}`);
  return new Date(`${weekKey}T00:00:00.000Z`);
}

/** Half-open range [start, end). */
export function weekRange(weekKey: string): { start: Date; end: Date } {
  const start = assertWeekKey(weekKey);
  return { start, end: new Date(start.getTime() + WEEK_MS) };
}

export function nextWeekKey(weekKey: string): string {
  return weekRange(weekKey).end.toISOString().slice(0, 10);
}

export function previousWeekKey(weekKey: string): string {
  const start = assertWeekKey(weekKey);
  return new Date(start.getTime() - WEEK_MS).toISOString().slice(0, 10);
}

export function secondsUntilReset(now: Date): number {
  const { end } = weekRange(weekKeyFor(now));
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 1000));
}
