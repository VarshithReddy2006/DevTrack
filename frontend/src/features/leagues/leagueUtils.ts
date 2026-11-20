import { LEAGUE_DIVISIONS } from './types';
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

// ---------------------------------------------------------------------------
// Promotion celebration. The API only returns the current division, so the
// last division the user acknowledged is kept in localStorage per account.
// ---------------------------------------------------------------------------

export function isLeagueDivision(value: unknown): value is LeagueDivision {
  return typeof value === 'string' && (LEAGUE_DIVISIONS as readonly string[]).includes(value);
}

/** Position in the ladder, 0 for Bronze. */
export function divisionIndex(division: LeagueDivision): number {
  return LEAGUE_DIVISIONS.indexOf(division);
}

export function nextDivision(division: LeagueDivision): LeagueDivision | null {
  return LEAGUE_DIVISIONS[divisionIndex(division) + 1] ?? null;
}

const SEEN_DIVISION_PREFIX = 'devtrack:leagues:seen-division:';

export function loadSeenDivision(userId: string): LeagueDivision | null {
  try {
    const value = localStorage.getItem(SEEN_DIVISION_PREFIX + userId);
    return isLeagueDivision(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveSeenDivision(userId: string, division: LeagueDivision): void {
  try {
    localStorage.setItem(SEEN_DIVISION_PREFIX + userId, division);
  } catch {
    // storage blocked: the celebration may show again next session
  }
}

export interface LeaguePromotion {
  from: LeagueDivision;
  to: LeagueDivision;
}

/** A promotion exists only when the current division is above the last one the user saw. */
export function detectPromotion(seen: LeagueDivision | null, current: LeagueDivision | null): LeaguePromotion | null {
  if (!seen || !current) return null;
  return divisionIndex(current) > divisionIndex(seen) ? { from: seen, to: current } : null;
}

/**
 * What actually changes for a promoted user. The product has no tier rewards yet,
 * so these describe the new standing rather than inventing perks.
 */
export function promotionPerks(to: LeagueDivision, promotionSlots: number, cohortSize: number): string[] {
  const label = divisionLabel(to);
  const perks = [`The ${label} badge on your league standings`];
  if (cohortSize > 0) perks.push(`A new ${cohortSize}-player ${label} cohort to compete in this week`);
  else perks.push(`A place in the ${label} league for this week`);
  const next = nextDivision(to);
  if (!next) perks.push(`You've reached the top league, so the climb is about holding your place`);
  else if (promotionSlots > 0) perks.push(`Finish in the top ${promotionSlots} this week to move up to ${divisionLabel(next)}`);
  else perks.push(`Finish in the promotion zone this week to move up to ${divisionLabel(next)}`);
  return perks;
}
