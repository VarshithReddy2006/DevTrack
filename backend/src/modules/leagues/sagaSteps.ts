// src/modules/leagues/sagaSteps.ts — Atomic step definitions and inverse compensations for cohort rollover.
//
// Every forward step captures checkpoint snapshots so that an unhandled failure or worker abort
// can trigger inverse compensation to cleanly revert mutations and maintain database consistency.

import { Types } from 'mongoose';
import { LeagueStanding, ProfileAuditLog, XpTransaction } from '../../db/models/index.js';
import type { LeagueDivision, LeagueOutcome, LeagueStandingStatus } from '../../db/models/index.js';
import type {
  ILeagueRolloverLog,
  ILeagueRolloverPreviousStanding,
  SagaCohortStep,
} from '../../db/models/leagueRolloverLog.model.js';
import { logger } from '../../shared/logger.js';
import { FINISHED_WEEK_TTL_SECONDS, cohortKey } from './leagues.constants.js';
import { readCohortBoard, type RankedMember } from './leagues.service.js';
import { computeCohortOutcomes, type FinalStanding } from './rollover.js';
import type { LeagueScoreStore } from './scoreStore.js';
import { analyzeSolveEntropy, type XpEvent } from './solveEntropy.service.js';
import { weekRange } from './weeks.js';

export interface PreviousStandingState {
  userId: string;
  division: LeagueDivision;
  cohortId: string;
  status: LeagueStandingStatus;
  points: number;
  rank: number | null;
  cohortSize: number | null;
  outcome: LeagueOutcome | null;
  nextDivision: LeagueDivision | null;
  finalizedAt: Date | null;
  notifiedAt: Date | null;
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

      // Evaluate solve entropy for all active cohort members to mitigate last-minute sniping
      let finalBoard = ctx.board;
      try {
        const { start, end } = weekRange(ctx.weekKey);
        const userObjIds = Array.from(activeUserIds).map(id => new Types.ObjectId(id));
        const txs = await XpTransaction.find({
          userId: { $in: userObjIds },
          createdAt: { $gte: start, $lt: end },
        })
          .select('userId xpAwarded createdAt')
          .lean<Array<{ userId: Types.ObjectId; xpAwarded: number; createdAt: Date }>>();

        const eventsByUser = new Map<string, XpEvent[]>();
        for (const tx of txs) {
          const uid = tx.userId.toString();
          if (!eventsByUser.has(uid)) eventsByUser.set(uid, []);
          eventsByUser.get(uid)!.push({ at: tx.createdAt, xp: tx.xpAwarded });
        }

        const auditEntries: Array<{
          userId: Types.ObjectId;
          eventType: 'anti_gaming_check';
          triggeredBy: 'system';
          details: Record<string, unknown>;
        }> = [];

        const adjustedBoard: RankedMember[] = ctx.board.map(member => {
          if (!activeUserIds.has(member.userId)) return member;
          const userEvents = eventsByUser.get(member.userId) ?? [];
          if (userEvents.length === 0) return member;

          const res = analyzeSolveEntropy(userEvents, ctx.weekKey);
          if (res.verdict === 'sniping') {
            if (res.audit) {
              auditEntries.push({
                userId: new Types.ObjectId(member.userId),
                eventType: 'anti_gaming_check',
                triggeredBy: 'system',
                details: {
                  reason: res.audit.reason,
                  cohortId: ctx.cohortId,
                  division: ctx.division,
                  weekKey: ctx.weekKey,
                  ...res.audit.details,
                },
              });
            }
            return { userId: member.userId, points: Math.round(res.adjustedXp) };
          }
          if (res.verdict === 'consistent') {
            return { userId: member.userId, points: Math.round(res.adjustedXp) };
          }
          return member;
        });

        // Re-sort the board according to adjusted points best-first
        adjustedBoard.sort((a, b) => b.points - a.points);
        finalBoard = adjustedBoard;

        if (auditEntries.length > 0) {
          await ProfileAuditLog.insertMany(auditEntries, { ordered: false }).catch(err => {
            logger.warn('[saga-step] Failed to persist entropy audit entries', { error: err });
          });
        }
      } catch (entropyErr) {
        // Never crash rollover worker if entropy analysis fails
        logger.warn('[saga-step] Entropy analysis bypassed due to error', { error: entropyErr });
      }

      const allOutcomes = computeCohortOutcomes(ctx.division, finalBoard);
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

      // Capture pre-mutation state (including division & cohortId) in memory and saga log
      // before mutating MongoDB so both in-process and crash-recovery compensation can restore exact state.
      const currentRows = await LeagueStanding.find({
        weekKey: ctx.weekKey,
        userId: { $in: ctx.outcomes.map(s => new Types.ObjectId(s.userId)) },
      }).lean<Array<{
        userId: Types.ObjectId;
        division: LeagueDivision;
        cohortId: string;
        status: LeagueStandingStatus;
        points: number;
        rank: number | null;
        cohortSize: number | null;
        outcome: LeagueOutcome | null;
        nextDivision: LeagueDivision | null;
        finalizedAt: Date | null;
        notifiedAt: Date | null;
      }>>();

      const prevMap = new Map<string, PreviousStandingState>();
      const prevLogEntries: ILeagueRolloverPreviousStanding[] = [];
      for (const r of currentRows) {
        const prev: PreviousStandingState = {
          userId: r.userId.toString(),
          division: r.division,
          cohortId: r.cohortId,
          status: r.status,
          points: r.points,
          rank: r.rank ?? null,
          cohortSize: r.cohortSize ?? null,
          outcome: r.outcome ?? null,
          nextDivision: r.nextDivision ?? null,
          finalizedAt: r.finalizedAt ?? null,
          notifiedAt: r.notifiedAt ?? null,
        };
        prevMap.set(prev.userId, prev);
        prevLogEntries.push(prev);
      }
      ctx.previousStandings = prevMap;

      if (!ctx.log.snapshot) {
        ctx.log.snapshot = { board: [], standings: [], previousStandings: prevLogEntries };
      } else {
        ctx.log.snapshot.previousStandings = prevLogEntries;
      }
      await ctx.log.save();

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
      const priorStates: ILeagueRolloverPreviousStanding[] =
        ctx.previousStandings && ctx.previousStandings.size > 0
          ? [...ctx.previousStandings.values()]
          : (ctx.log.snapshot?.previousStandings ?? []);

      if (priorStates.length > 0) {
        const ops = priorStates.map(prev => ({
          updateOne: {
            filter: { weekKey: ctx.weekKey, userId: new Types.ObjectId(prev.userId) },
            update: {
              $set: {
                division: prev.division,
                cohortId: prev.cohortId,
                status: prev.status,
                points: prev.points,
                rank: prev.rank ?? null,
                cohortSize: prev.cohortSize ?? null,
                outcome: prev.outcome ?? null,
                nextDivision: prev.nextDivision ?? null,
                finalizedAt: prev.finalizedAt ?? null,
                notifiedAt: prev.notifiedAt ?? null,
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
