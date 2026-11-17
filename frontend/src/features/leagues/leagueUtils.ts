import type { LeagueDivision, LeagueZone, LeagueCohortMember, RankSnapshot } from './types';

export function zoneForRank(
  rank: number,
  cohortSize: number,
  promotionSlots: number,
  demotionSlots: number,
): LeagueZone {
  if (promotionSlots > 0 && rank <= promotionSlots) return 'promotion';
  if (demotionSlots > 0 && rank > cohortSize - demotionSlots) return 'demotion';
  return 'safe';
}

export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  /** True once the target time has passed. */
  ended: boolean;
}

export function getCountdownParts(targetMs: number, nowMs: number): CountdownParts {
  const remaining = targetMs - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return { days: 0, hours: 0, minutes: 0, ended: true };
  const totalMinutes = Math.floor(remaining / 60_000);
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
    ended: false,
  };
}

const DIVISION_LABELS: Record<LeagueDivision, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  diamond: 'Diamond',
  master: 'Master',
  grandmaster: 'Grandmaster',
};

export function divisionLabel(division: LeagueDivision | null): string {
  return division ? DIVISION_LABELS[division] ?? division : 'Unranked';
}

export function memberName(member: Pick<LeagueCohortMember, 'displayName' | 'username'>): string {
  return member.displayName?.trim() || member.username?.trim() || 'Anonymous';
}

const POINTS_FORMAT = new Intl.NumberFormat('en-US');
export function formatPoints(points: number): string {
  return POINTS_FORMAT.format(points);
}

/** Positive means the member moved up (rank number went down). Null when there is no earlier rank. */
export function rankChange(previous: RankSnapshot | null | undefined, member: LeagueCohortMember): number | null {
  const before = previous?.[member.userId];
  return before === undefined ? null : before - member.rank;
}

export function toRankSnapshot(standings: LeagueCohortMember[]): RankSnapshot {
  return Object.fromEntries(standings.map((member) => [member.userId, member.rank]));
}

// ---------------------------------------------------------------------------
// The API has no previous rank, so "since you last looked" is kept in localStorage.
// ---------------------------------------------------------------------------

const SNAPSHOT_PREFIX = 'devtrack:leagues:ranks:';

function snapshotKey(weekKey: string, cohortId: string | null): string {
  return `${SNAPSHOT_PREFIX}${weekKey}:${cohortId ?? 'none'}`;
}

export function loadRankSnapshot(weekKey: string, cohortId: string | null): RankSnapshot | null {
  try {
    const raw = localStorage.getItem(snapshotKey(weekKey, cohortId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (!entries.every(([, rank]) => typeof rank === 'number')) return null;
    return Object.fromEntries(entries) as RankSnapshot;
  } catch {
    return null;
  }
}

export function saveRankSnapshot(weekKey: string, cohortId: string | null, snapshot: RankSnapshot): void {
  try {
    localStorage.setItem(snapshotKey(weekKey, cohortId), JSON.stringify(snapshot));
  } catch {
    // storage full or blocked: deltas just stay hidden
  }
}
