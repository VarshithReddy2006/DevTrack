// src/modules/leagues/rollover.ts — Weekly league rollover (Sunday 00:00 UTC).
//
// For the week that just ended: read the final ranking of every cohort from Redis, write
// rank/points/outcome into the LeagueStanding rows, promote the top 20% and demote the bottom
// 20%, place everyone in fresh cohorts for the new week and notify them over SSE.
//
// Idempotency: every step is keyed on (weekKey, userId). Phase 1 only touches rows that are
// still 'active', phase 2 only inserts rows that do not exist yet ($setOnInsert) and phase 3 uses
// ZADD NX. Running the rollover again, or after a crash halfway, converges on the same result
// and never promotes or demotes anybody twice.

import { Types } from 'mongoose';
import { LeagueStanding, UserSettings } from '../../db/models/index.js';
import type { LeagueDivision, LeagueOutcome } from '../../db/models/index.js';
import { LEAGUE_DIVISIONS } from '../../db/models/index.js';
import { eventBus } from '../../shared/sse/index.js';
import { logger } from '../../shared/logger.js';
import { assignCohorts } from './cohorts.js';
import { FINISHED_WEEK_TTL_SECONDS, cohortKey, nextDivision, previousDivision } from './leagues.constants.js';
import { readCohortBoard, zoneSlots, type RankedMember } from './leagues.service.js';
import type { LeagueScoreStore } from './scoreStore.js';
import { nextWeekKey, weekRange } from './weeks.js';

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
}

const WRITE_BATCH = 500;

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

async function defaultNotify(userId: string, payload: WeekFinalizedPayload): Promise<void> {
  await eventBus.publishEnvelope(userId, 'league_week_finalized', { ...payload });
}

export async function runWeeklyRollover(weekKey: string, options: RolloverOptions): Promise<RolloverResult> {
  const { store, now = new Date(), notify = defaultNotify } = options;
  const upcomingWeekKey = nextWeekKey(weekKey);
  const result: RolloverResult = { weekKey, nextWeekKey: upcomingWeekKey, finalized: 0, promoted: 0, demoted: 0, assigned: 0 };

  // ── Phase 1: finalize each cohort that still has active rows ──────────────
  const cohorts = await LeagueStanding.aggregate<{ _id: { division: LeagueDivision; cohortId: string } }>([
    { $match: { weekKey, status: 'active' } },
    { $group: { _id: { division: '$division', cohortId: '$cohortId' } } },
    { $sort: { '_id.division': 1, '_id.cohortId': 1 } },
  ]);

  const finalizedNow: Array<FinalStanding & { division: LeagueDivision }> = [];
  for (const { _id: { division, cohortId } } of cohorts) {
    // Rank the whole cohort, including rows a crashed earlier run already finalized, so ranks
    // never depend on how far that run got. Only rows still active are written below.
    const board = await readCohortBoard(weekKey, division, cohortId, store);
    const stillActive = new Set(
      (await LeagueStanding.find({ weekKey, division, cohortId, status: 'active' })
        .select('userId')
        .lean<Array<{ userId: Types.ObjectId }>>()).map(row => row.userId.toString()),
    );
    const standings = computeCohortOutcomes(division, board).filter(s => stillActive.has(s.userId));
    const finalizedAt = now;
    const writes = await LeagueStanding.bulkWrite(
      standings.map(s => ({
        updateOne: {
          // The status filter is what makes a second run a no-op for this row.
          filter: { weekKey, userId: new Types.ObjectId(s.userId), status: 'active' as const },
          update: {
            $set: {
              status: 'finalized' as const, points: s.points, rank: s.rank, cohortSize: s.cohortSize,
              outcome: s.outcome, nextDivision: s.nextDivision, finalizedAt,
            },
          },
        },
      })),
    );
    if (writes.modifiedCount > 0) {
      result.finalized += writes.modifiedCount;
      for (const s of standings) {
        if (s.outcome === 'promoted') result.promoted++;
        if (s.outcome === 'demoted') result.demoted++;
        finalizedNow.push({ ...s, division });
      }
    }
    // Keep the finished week readable for a while, then let Redis drop it.
    await store.expire(cohortKey(weekKey, division, cohortId), FINISHED_WEEK_TTL_SECONDS);
  }

  // ── Phase 2: place the opted-in users in new cohorts for the next week ────
  const finished = await LeagueStanding.find({ weekKey, status: 'finalized' })
    .select('userId nextDivision')
    .lean<Array<{ userId: Types.ObjectId; nextDivision: LeagueDivision }>>();
  const optedIn = new Set(
    (await UserSettings.find({ userId: { $in: finished.map(f => f.userId) }, 'leagues.participate': true })
      .select('userId')
      .lean<Array<{ userId: Types.ObjectId }>>()).map(s => s.userId.toString()),
  );

  const byDivision = new Map<LeagueDivision, string[]>();
  for (const row of finished) {
    const id = row.userId.toString();
    if (!optedIn.has(id)) continue;
    byDivision.set(row.nextDivision, [...(byDivision.get(row.nextDivision) ?? []), id]);
  }

  const { end: upcomingStart } = weekRange(weekKey);
  const placements: Array<{ userId: string; division: LeagueDivision; cohortId: string }> = [];
  for (const division of LEAGUE_DIVISIONS) {
    const ids = byDivision.get(division);
    if (!ids) continue;
    for (const { userId, cohortId } of assignCohorts(ids, `${upcomingWeekKey}:${division}`)) {
      placements.push({ userId, division, cohortId });
    }
  }
  for (let i = 0; i < placements.length; i += WRITE_BATCH) {
    const writes = await LeagueStanding.bulkWrite(
      placements.slice(i, i + WRITE_BATCH).map(p => ({
        updateOne: {
          filter: { weekKey: upcomingWeekKey, userId: new Types.ObjectId(p.userId) },
          update: {
            $setOnInsert: {
              weekKey: upcomingWeekKey, userId: new Types.ObjectId(p.userId), division: p.division, cohortId: p.cohortId,
              status: 'active' as const, joinedAt: upcomingStart, points: 0,
              rank: null, cohortSize: null, outcome: null, nextDivision: null, finalizedAt: null,
            },
          },
          upsert: true,
        },
      })),
    );
    result.assigned += writes.upsertedCount;
  }

  // ── Phase 3: make every member of the new week visible on its Redis board ─
  const upcoming = await LeagueStanding.find({ weekKey: upcomingWeekKey, status: 'active' })
    .select('userId division cohortId')
    .lean<Array<{ userId: Types.ObjectId; division: LeagueDivision; cohortId: string }>>();
  const members = new Map<string, { division: LeagueDivision; cohortId: string; ids: string[] }>();
  for (const row of upcoming) {
    const key = cohortKey(upcomingWeekKey, row.division, row.cohortId);
    const entry = members.get(key) ?? { division: row.division, cohortId: row.cohortId, ids: [] };
    entry.ids.push(row.userId.toString());
    members.set(key, entry);
  }
  for (const [key, entry] of members) await store.seed(key, entry.ids);

  // ── Notify only the users finalized by this run ───────────────────────────
  for (const s of finalizedNow) {
    try {
      await notify(s.userId, {
        weekKey, division: s.division, rank: s.rank, points: s.points,
        cohortSize: s.cohortSize, outcome: s.outcome, nextDivision: s.nextDivision,
      });
    } catch (error) {
      logger.warn('[leagues] league.week.finalized notification failed', {
        event: 'league_week_finalized_notify_failed', weekKey, userId: s.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('[leagues] Weekly rollover complete', { event: 'league_rollover_complete', ...result });
  return result;
}
