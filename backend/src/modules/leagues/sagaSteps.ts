// src/modules/leagues/sagaSteps.ts — Atomic step definitions and inverse compensations for cohort rollover.
//
// Every forward step captures checkpoint snapshots so that an unhandled failure or worker abort
// can trigger inverse compensation to cleanly revert mutations and maintain database consistency.

import { Types } from 'mongoose';
import { LeagueStanding } from '../../db/models/index.js';
import type { LeagueDivision, LeagueOutcome, LeagueStandingStatus } from '../../db/models/index.js';
import type { ILeagueRolloverLog, SagaCohortStep } from '../../db/models/leagueRolloverLog.model.js';
import { FINISHED_WEEK_TTL_SECONDS, cohortKey } from './leagues.constants.js';
import { readCohortBoard, type RankedMember } from './leagues.service.js';
import { computeCohortOutcomes, type FinalStanding } from './rollover.js';
import type { LeagueScoreStore } from './scoreStore.js';

export interface PreviousStandingState {
  userId: string;
  status: LeagueStandingStatus;
  points: number;
  rank: number | null;
  cohortSize: number | null;
  outcome: LeagueOutcome | null;
  nextDivision: LeagueDivision | null;
  finalizedAt: Date | null;
}

export interface SagaCohortContext {
  weekKey: string;
  upcomingWeekKey: string;
  division: LeagueDivision;
  cohortId: string;
  store: LeagueScoreStore;
  now: Date;
  log: ILeagueRolloverLog;
  board?: RankedMember[];
  outcomes?: FinalStanding[];
  affectedUserIds?: string[];
  previousStandings?: Map<string, PreviousStandingState>;
  modifiedCount?: number;
}

export interface ISagaStep {
  name: SagaCohortStep;
  execute: (ctx: SagaCohortContext) => Promise<void>;
  compensate: (ctx: SagaCohortContext) => Promise<void>;
}

export const sagaCohortSteps: ISagaStep[] = [
  {
    name: 'snapshot_scores',
    async execute(ctx: SagaCohortContext): Promise<void> {
      const board = await readCohortBoard(ctx.weekKey, ctx.division, ctx.cohortId, ctx.store);
      ctx.board = board;
      ctx.log.snapshot = {
        board: board.map(b => ({ userId: b.userId, points: b.points })),
        standings: [],
      };
      await ctx.store.expire(cohortKey(ctx.weekKey, ctx.division, ctx.cohortId), FINISHED_WEEK_TTL_SECONDS);
    },
    async compensate(_ctx: SagaCohortContext): Promise<void> {
      // Score reading and TTL expiry are non-destructive read operations; no rollback needed.
    },
  },
  {
    name: 'compute_outcomes',
    async execute(ctx: SagaCohortContext): Promise<void> {
      if (!ctx.board) {
        throw new Error(`[saga-step] Cannot compute outcomes without board snapshot for ${ctx.division}:${ctx.cohortId}`);
      }

      // Rank entire cohort, filtering only members who are still active
      const activeUsers = await LeagueStanding.find({
        weekKey: ctx.weekKey,
        division: ctx.division,
        cohortId: ctx.cohortId,
        status: 'active',
      })
        .select('userId')
        .lean<Array<{ userId: Types.ObjectId }>>();

      const activeUserIds = new Set(activeUsers.map(u => u.userId.toString()));
      const allOutcomes = computeCohortOutcomes(ctx.division, ctx.board);
      const outcomes = allOutcomes.filter(s => activeUserIds.has(s.userId));

      ctx.outcomes = outcomes;
      ctx.affectedUserIds = outcomes.map(s => s.userId);

      if (ctx.log.snapshot) {
        ctx.log.snapshot.standings = outcomes.map(s => ({
          userId: s.userId,
          rank: s.rank,
          points: s.points,
          cohortSize: s.cohortSize,
          outcome: s.outcome,
          nextDivision: s.nextDivision,
        }));
      }
    },
    async compensate(_ctx: SagaCohortContext): Promise<void> {
      // In-memory pure calculation; compensation is a no-op.
    },
  },
  {
    name: 'persist_standings',
    async execute(ctx: SagaCohortContext): Promise<void> {
      if (!ctx.outcomes) {
        throw new Error(`[saga-step] Cannot persist standings without computed outcomes for ${ctx.division}:${ctx.cohortId}`);
      }

      if (ctx.outcomes.length === 0) {
        ctx.modifiedCount = 0;
        return;
      }

      // Capture pre-mutation state to support exact compensation restoration
      const currentRows = await LeagueStanding.find({
        weekKey: ctx.weekKey,
        userId: { $in: ctx.outcomes.map(s => new Types.ObjectId(s.userId)) },
      }).lean<Array<{
        userId: Types.ObjectId;
        status: LeagueStandingStatus;
        points: number;
        rank: number | null;
        cohortSize: number | null;
        outcome: LeagueOutcome | null;
        nextDivision: LeagueDivision | null;
        finalizedAt: Date | null;
      }>>();

      const prevMap = new Map<string, PreviousStandingState>();
      for (const r of currentRows) {
        prevMap.set(r.userId.toString(), {
          userId: r.userId.toString(),
          status: r.status,
          points: r.points,
          rank: r.rank,
          cohortSize: r.cohortSize,
          outcome: r.outcome,
          nextDivision: r.nextDivision,
          finalizedAt: r.finalizedAt,
        });
      }
      ctx.previousStandings = prevMap;

      const ops = ctx.outcomes.map(s => ({
        updateOne: {
          filter: { weekKey: ctx.weekKey, userId: new Types.ObjectId(s.userId), status: 'active' as const },
          update: {
            $set: {
              status: 'finalized' as const,
              points: s.points,
              rank: s.rank,
              cohortSize: s.cohortSize,
              outcome: s.outcome,
              nextDivision: s.nextDivision,
              finalizedAt: ctx.now,
            },
          },
        },
      }));

      const writes = await LeagueStanding.bulkWrite(ops);
      ctx.modifiedCount = writes.modifiedCount;
    },
    async compensate(ctx: SagaCohortContext): Promise<void> {
      if (ctx.previousStandings && ctx.previousStandings.size > 0) {
        const ops = [...ctx.previousStandings.values()].map(prev => ({
          updateOne: {
            filter: { weekKey: ctx.weekKey, userId: new Types.ObjectId(prev.userId) },
            update: {
              $set: {
                status: prev.status,
                points: prev.points,
                rank: prev.rank,
                cohortSize: prev.cohortSize,
                outcome: prev.outcome,
                nextDivision: prev.nextDivision,
                finalizedAt: prev.finalizedAt,
              },
            },
          },
        }));
        await LeagueStanding.bulkWrite(ops);
      } else if (ctx.affectedUserIds && ctx.affectedUserIds.length > 0) {
        await LeagueStanding.updateMany(
          {
            weekKey: ctx.weekKey,
            userId: { $in: ctx.affectedUserIds.map(id => new Types.ObjectId(id)) },
            status: 'finalized',
          },
          {
            $set: {
              status: 'active',
              points: 0,
              rank: null,
              cohortSize: null,
              outcome: null,
              nextDivision: null,
              finalizedAt: null,
              notifiedAt: null,
            },
          },
        );
      } else {
        await LeagueStanding.updateMany(
          {
            weekKey: ctx.weekKey,
            division: ctx.division,
            cohortId: ctx.cohortId,
            status: 'finalized',
          },
          {
            $set: {
              status: 'active',
              points: 0,
              rank: null,
              cohortSize: null,
              outcome: null,
              nextDivision: null,
              finalizedAt: null,
              notifiedAt: null,
            },
          },
        );
      }
    },
  },
];
