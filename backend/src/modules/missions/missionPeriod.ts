export type MissionPeriodType = 'daily' | 'weekly';

export function getMissionPeriod(type: MissionPeriodType, now: Date) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (type === 'weekly') {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + (type === 'daily' ? 1 : 7));
  return { key: `${type}:${start.toISOString().slice(0, 10)}`, start, end };
}
