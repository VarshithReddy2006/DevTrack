// src/modules/leagues/rollover.ts — Weekly league rollover (Sunday 00:00 UTC).
//
// For the week that just ended: read the final ranking of every cohort from Redis, write
// rank/points/outcome into the LeagueStanding rows, promote the top 20% and demote the bottom
// 20%, place everyone in fresh cohorts for the new week and notify them over SSE.
//
// Coordinated via two-phase commit Saga Orchestrator with durable checkpoint ledger,
// atomic step execution, reverse compensation rollback on failure, and crash-recovery.

import type { LeagueDivision, LeagueOutcome } from '../../db/models/index.js';
import { LEAGUE_DIVISIONS } from '../../db/models/index.js';
import { nextDivision, previousDivision } from './leagues.constants.js';
import { zoneSlots, type RankedMember } from './leagues.service.js';
import {
  RolloverSagaOrchestrator,
  DEFAULT_STALLED_LEASE_TIMEOUT_MS,
  type SagaRolloverResult,
  type SagaCohortExecutionResult,
} from './rolloverSaga.orchestrator.js';
import type { LeagueScoreStore } from './scoreStore.js';

export interface FinalStanding {
  userId: string;
  rank: number;
  points: number;
  cohortSize: number;
  outcome: LeagueOutcome;
  nextDivision: LeagueDivision;
}

export interface WeekFinalizedPayload {
  weekKey: string;
  division: LeagueDivision;
  rank: number;
  points: number;
  cohortSize: number;
  outcome: LeagueOutcome;
  nextDivision: LeagueDivision;
}

export interface RolloverResult {
  weekKey: string;
  nextWeekKey: string;
  /** Rows moved from active to finalized by this run (0 when the week was already done). */
  finalized: number;
  promoted: number;
  demoted: number;
  /** New-week rows inserted by this run. */
  assigned: number;
}

export interface RolloverOptions {
  store: LeagueScoreStore;
  now?: Date;
  /** Defaults to an SSE `league_week_finalized` event to the user. */
  notify?: (userId: string, payload: WeekFinalizedPayload) => Promise<void>;
  /**
   * Minimum duration (in milliseconds) an 'in_progress' cohort must remain untouched
   * before it is considered stalled and eligible for crash-recovery rollback.
   * Default: 5 minutes (300,000 ms).
   */
  stalledLeaseTimeoutMs?: number;
}

export {
  RolloverSagaOrchestrator,
  DEFAULT_STALLED_LEASE_TIMEOUT_MS,
  type SagaRolloverResult,
  type SagaCohortExecutionResult,
};

/**
 * Ranks a finished cohort and decides who moves. `board` must already be ordered best first.
 * The top 20% (rounded down) move up one division, the bottom 20% move down one. Bronze
 * cannot be demoted and Grandmaster cannot be promoted: those users stay.
 */
export function computeCohortOutcomes(division: LeagueDivision, board: RankedMember[]): FinalStanding[] {
  const size = board.length;
  const slots = zoneSlots(size);
  const canPromote = division !== LEAGUE_DIVISIONS[LEAGUE_DIVISIONS.length - 1];
  const canDemote = division !== LEAGUE_DIVISIONS[0];

  return board.map((member, index) => {
    const rank = index + 1;
    let outcome: LeagueOutcome = 'stayed';
    if (canPromote && rank <= slots.promotion) outcome = 'promoted';
    else if (canDemote && rank > size - slots.demotion) outcome = 'demoted';
    return {
      userId: member.userId,
      rank,
      points: member.points,
      cohortSize: size,
      outcome,
      nextDivision:
        outcome === 'promoted' ? nextDivision(division) : outcome === 'demoted' ? previousDivision(division) : division,
    };
  });
}

/**
 * Runs the weekly league rollover using the two-phase commit Saga Orchestrator.
 */
export async function runWeeklyRollover(weekKey: string, options: RolloverOptions): Promise<SagaRolloverResult> {
  const orchestrator = new RolloverSagaOrchestrator(options);
  return orchestrator.executeRollover(weekKey);
}
