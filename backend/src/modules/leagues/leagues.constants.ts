// src/modules/leagues/leagues.constants.ts — Tunables and Redis key builders for weekly leagues.
import { LEAGUE_DIVISIONS, type LeagueDivision } from '../../db/models/leagueStanding.model.js';

/** Cohorts are filled up to this many participants. */
export const TARGET_COHORT_SIZE = 30;
/** A leftover cohort smaller than this is merged into the previous one. */
export const MIN_COHORT_SIZE = 10;
/** Percent of each cohort promoted (top) and demoted (bottom) at rollover. */
export const PROMOTION_PERCENT = 20;
export const DEMOTION_PERCENT = 20;

export const DEFAULT_DIVISION: LeagueDivision = 'bronze';

/** Finished weeks stay readable in Redis for this long, then expire on their own. */
export const FINISHED_WEEK_TTL_SECONDS = 14 * 24 * 60 * 60;
/** Idempotency markers for score increments only need to outlive the week. */
export const SCORE_DEDUPE_TTL_SECONDS = 21 * 24 * 60 * 60;

export function nextDivision(division: LeagueDivision): LeagueDivision {
  const index = LEAGUE_DIVISIONS.indexOf(division);
  return LEAGUE_DIVISIONS[Math.min(index + 1, LEAGUE_DIVISIONS.length - 1)];
}

export function previousDivision(division: LeagueDivision): LeagueDivision {
  const index = LEAGUE_DIVISIONS.indexOf(division);
  return LEAGUE_DIVISIONS[Math.max(index - 1, 0)];
}

/** league:{weekKey}:{division}:{cohortId} */
export function cohortKey(weekKey: string, division: LeagueDivision, cohortId: string): string {
  return `league:${weekKey}:${division}:${cohortId}`;
}

/** Set of already-applied XP awards for a week, so a replayed job never double counts. */
export function dedupeSetKey(weekKey: string): string {
  return `league:${weekKey}:applied`;
}
