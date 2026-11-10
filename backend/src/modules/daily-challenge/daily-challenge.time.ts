export function resolveTimezone(timezone?: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'UTC' });
    return timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function localDateString(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// Find the first instant of a calendar date rather than adding 24 hours: local
// days can be 23 or 25 hours, and some zones change offset at midnight.
export function localDayBounds(dateStr: string, timezone: string): { start: Date; end: Date } {
  const midnight = Date.parse(`${dateStr}T00:00:00Z`);
  const nextDate = new Date(midnight + 86_400_000).toISOString().slice(0, 10);
  const boundary = (target: string, anchor: number) => {
    let low = anchor - 36 * 3_600_000;
    let high = anchor + 36 * 3_600_000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (localDateString(new Date(middle), timezone) < target) low = middle + 1;
      else high = middle;
    }
    return new Date(low);
  };
  return { start: boundary(dateStr, midnight), end: boundary(nextDate, midnight + 86_400_000) };
}
