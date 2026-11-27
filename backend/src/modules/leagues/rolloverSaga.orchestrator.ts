// src/modules/leagues/rolloverSaga.orchestrator.ts — Two-phase commit Saga Orchestrator for weekly league cohort rollover.
//
// Coordinates weekly league rollover across all cohorts with durable checkpointing,
// atomic step execution, reverse compensation rollback on failure, crash-recovery,
// and lifecycle completion event broadcasting.

import { Types } from 'mongoose';
import { LeagueStanding, UserSettings, type LeagueDivision, type LeagueOutcome } from '../../db/models/index.js';
import { LEAGUE_DIVISIONS } from '../../db/models/index.js';
import {
  LeagueRolloverLog,
  type ILeagueRolloverLog,
  type ILeagueRolloverNextWeekPlacement,
} from '../../db/models/leagueRolloverLog.model.js';
import { logger } from '../../shared/logger.js';
import { leagueSagaRollbacks } from '../../shared/observability/metrics.js';
import { eventBus } from '../../shared/sse/index.js';
import { assignCohorts } from './cohorts.js';
import { cohortKey } from './leagues.constants.js';
import { type FinalStanding, type RolloverOptions, type RolloverResult, type WeekFinalizedPayload } from './rollover.js';
import { sagaCohortSteps, type ISagaStep, type SagaCohortContext } from './sagaSteps.js';
import type { LeagueScoreStore } from './scoreStore.js';
import { nextWeekKey, weekRange } from './weeks.js';

export interface SagaCohortExecutionResult {
  cohortId: string;
  division: LeagueDivision;
  status: 'committed' | 'compensated' | 'skipped';
  finalizedCount: number;
  promotedCount: number;
  demotedCount: number;
  finalizedStandings?: Array<FinalStanding & { division: LeagueDivision }>;
  error?: string;
}

export interface SagaRolloverResult extends RolloverResult {
  cohortResults: SagaCohortExecutionResult[];
  compensatedCohorts: number;
  stalledRecovered: number;
}

export const DEFAULT_STALLED_LEASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const WRITE_BATCH = 500;

async function defaultNotify(userId: string, payload: WeekFinalizedPayload): Promise<void> {
  await eventBus.publishEnvelope(userId, 'league_week_finalized', { ...payload });
}

export class RolloverSagaOrchestrator {
  private readonly store: LeagueScoreStore;
  private readonly now: Date;
  private readonly notify: (userId: string, payload: WeekFinalizedPayload) => Promise<void>;
  private readonly stalledLeaseTimeoutMs: number;

  constructor(options: RolloverOptions) {
    this.store = options.store;
    this.now = options.now ?? new Date();
    this.notify = options.notify ?? defaultNotify;
    this.stalledLeaseTimeoutMs = options.stalledLeaseTimeoutMs ?? DEFAULT_STALLED_LEASE_TIMEOUT_MS;
  }

  /**
   * Executes the weekly league rollover across all cohorts as a multi-phase Saga.
   */
  async executeRollover(weekKey: string): Promise<SagaRolloverResult> {
    const upcomingWeekKey = nextWeekKey(weekKey);
    logger.info('[saga] Initiating weekly league rollover saga', {
      event: 'league_saga_starting',
      weekKey,
      upcomingWeekKey,
    });

    // ── Phase 0: Crash Recovery / Stalled Cohort Checkpoint Reconciliation ───
    const stalledRecovered = await this.recoverStalledCohorts(weekKey, upcomingWeekKey);

    const result: SagaRolloverResult = {
      weekKey,
      nextWeekKey: upcomingWeekKey,
      finalized: 0,
      promoted: 0,
      demoted: 0,
      assigned: 0,
      cohortResults: [],
      compensatedCohorts: 0,
      stalledRecovered,
    };

    // ── Phase 1: Cohort-by-Cohort Saga Execution ────────────────────────────
    const activeCohorts = await LeagueStanding.aggregate<{ _id: { division: LeagueDivision; cohortId: string } }>([
      { $match: { weekKey, status: 'active' } },
      { $group: { _id: { division: '$division', cohortId: '$cohortId' } } },
      { $sort: { '_id.division': 1, '_id.cohortId': 1 } },
    ]);

    const finalizedNow: Array<FinalStanding & { division: LeagueDivision }> = [];

    for (const { _id: { division, cohortId } } of activeCohorts) {
      const cohortOutcome = await this.processCohortWithSaga(weekKey, upcomingWeekKey, division, cohortId);
      result.cohortResults.push(cohortOutcome);

      if (cohortOutcome.status === 'committed') {
        result.finalized += cohortOutcome.finalizedCount;
        result.promoted += cohortOutcome.promotedCount;
        result.demoted += cohortOutcome.demotedCount;
        if (cohortOutcome.finalizedStandings && cohortOutcome.finalizedCount > 0) {
          finalizedNow.push(...cohortOutcome.finalizedStandings);
        }
      } else if (cohortOutcome.status === 'compensated') {
        result.compensatedCohorts++;
      }
    }

    // ── Phase 2 & 3: Next-Week Placement and Redis Seeding ───────────────────
    if (result.compensatedCohorts === 0) {
      const { end: upcomingStart } = weekRange(weekKey);
      const { assigned } = await this.seedNextWeekCohorts(weekKey, upcomingWeekKey, upcomingStart);
      result.assigned = assigned;

      // ── Phase 4: User Notification ────────────────────────────────────────
      const unnotifiedStandings = await LeagueStanding.find({
        weekKey,
        status: 'finalized',
        $or: [{ notifiedAt: null }, { notifiedAt: { $exists: false } }],
      })
        .select('userId division rank points cohortSize outcome nextDivision')
        .lean<Array<{
          userId: Types.ObjectId;
          division: LeagueDivision;
          rank: number | null;
          points: number;
          cohortSize: number | null;
          outcome: LeagueOutcome | null;
          nextDivision: LeagueDivision | null;
        }>>();

      const notifiedIds: Types.ObjectId[] = [];

      for (const s of unnotifiedStandings) {
        try {
          await this.notify(s.userId.toString(), {
            weekKey,
            division: s.division,
            rank: s.rank ?? 1,
            points: s.points ?? 0,
            cohortSize: s.cohortSize ?? 1,
            outcome: s.outcome ?? 'stayed',
            nextDivision: s.nextDivision ?? s.division,
          });
          notifiedIds.push(s.userId);
        } catch (error) {
          logger.warn('[saga] User notification failed', {
            event: 'league_week_finalized_notify_failed',
            weekKey,
            userId: s.userId.toString(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (notifiedIds.length > 0) {
        for (let i = 0; i < notifiedIds.length; i += WRITE_BATCH) {
          const batch = notifiedIds.slice(i, i + WRITE_BATCH);
          await LeagueStanding.updateMany(
            { weekKey, userId: { $in: batch } },
            { $set: { notifiedAt: this.now } },
          );
        }
        await LeagueRolloverLog.updateMany(
          { weekKey, status: 'committed' },
          { $set: { notifiedAt: this.now } },
        );
      }

      // ── Phase 5: Completion Event Emission ────────────────────────────────
      const totalFinalized = await LeagueStanding.countDocuments({
        weekKey,
        status: 'finalized',
      });
      eventBus.emit('league.rollover_completed', {
        weekKey,
        upcomingWeekKey,
        totalFinalized,
        totalAssigned: result.assigned,
        timestamp: this.now.toISOString(),
      });
      eventBus.publish({
        type: 'league.rollover_completed' as any,
        timestamp: this.now.toISOString(),
        payload: {
          weekKey,
          upcomingWeekKey,
          totalFinalized,
          totalAssigned: result.assigned,
        },
      });
      logger.info('[saga] Weekly league rollover completed successfully', {
        event: 'league_rollover_completed',
        weekKey,
        finalized: totalFinalized,
        assigned: result.assigned,
      });
    } else {
      logger.error('[saga] Weekly league rollover completed with compensated failures', {
        event: 'league_rollover_partial_failure',
        weekKey,
        compensatedCohorts: result.compensatedCohorts,
      });
    }

    return result;
  }

  /**
   * Allocates finalized and opted-in users to new cohorts for the upcoming week and seeds Redis boards.
   * Records exact modified user IDs and prior placement markers in the saga log before mutating,
   * and executes full inverse compensation across MongoDB and Redis on failure.
   */
  private async seedNextWeekCohorts(
    weekKey: string,
    upcomingWeekKey: string,
    upcomingStart: Date,
  ): Promise<{ assigned: number }> {
    const finished = await LeagueStanding.find({ weekKey, status: 'finalized' })
      .select('userId division cohortId nextDivision')
      .lean<Array<{
        userId: Types.ObjectId;
        division: LeagueDivision;
        cohortId: string;
        nextDivision: LeagueDivision;
      }>>();

    const optedIn = new Set<string>();
    const finishedUserIds = finished.map((f) => f.userId);
    for (let i = 0; i < finishedUserIds.length; i += WRITE_BATCH) {
      const userBatch = finishedUserIds.slice(i, i + WRITE_BATCH);
      const settings = await UserSettings.find({
        userId: { $in: userBatch },
        'leagues.participate': true,
      })
        .select('userId')
        .lean<Array<{ userId: Types.ObjectId }>>();
      for (const s of settings) {
        optedIn.add(s.userId.toString());
      }
    }

    const priorOriginByUser = new Map<string, { division: LeagueDivision; cohortId: string }>();
    const byDivision = new Map<LeagueDivision, string[]>();
    for (const row of finished) {
      const id = row.userId.toString();
      if (!optedIn.has(id)) continue;
      priorOriginByUser.set(id, { division: row.division, cohortId: row.cohortId });
      byDivision.set(row.nextDivision, [...(byDivision.get(row.nextDivision) ?? []), id]);
    }

    const placements: Array<{
      userId: string;
      previousDivision: LeagueDivision;
      previousCohortId: string;
      division: LeagueDivision;
      cohortId: string;
    }> = [];
    for (const division of LEAGUE_DIVISIONS) {
      const ids = byDivision.get(division);
      if (!ids) continue;
      for (const { userId, cohortId } of assignCohorts(ids, `${upcomingWeekKey}:${division}`)) {
        const origin = priorOriginByUser.get(userId);
        placements.push({
          userId,
          previousDivision: origin?.division ?? division,
          previousCohortId: origin?.cohortId ?? cohortId,
          division,
          cohortId,
        });
      }
    }

    // Identify which users already have an upcoming-week standing so rollback never deletes pre-existing rows
    const preExistingUserIds = new Set<string>();
    const placementObjIds = placements.map((p) => new Types.ObjectId(p.userId));
    for (let i = 0; i < placementObjIds.length; i += WRITE_BATCH) {
      const batchIds = placementObjIds.slice(i, i + WRITE_BATCH);
      const existingRows = await LeagueStanding.find({
        weekKey: upcomingWeekKey,
        userId: { $in: batchIds },
      })
        .select('userId')
        .lean<Array<{ userId: Types.ObjectId }>>();
      for (const row of existingRows) {
        preExistingUserIds.add(row.userId.toString());
      }
    }

    const newPlacementUserIds = placements
      .filter((p) => !preExistingUserIds.has(p.userId))
      .map((p) => p.userId);
    const newPlacementUserIdSet = new Set(newPlacementUserIds);

    // Record exact modified user IDs and prior placement metadata per cohort in the saga log
    const placementsByOriginCohort = new Map<string, ILeagueRolloverNextWeekPlacement[]>();
    for (const p of placements) {
      const originKey = `${p.previousDivision}:${p.previousCohortId}`;
      const list = placementsByOriginCohort.get(originKey) ?? [];
      list.push({
        userId: p.userId,
        previousDivision: p.previousDivision,
        previousCohortId: p.previousCohortId,
        targetDivision: p.division,
        targetCohortId: p.cohortId,
        existedPrior: preExistingUserIds.has(p.userId),
      });
      placementsByOriginCohort.set(originKey, list);
    }

    // Advance cohort checkpoint logs to 'seed_next_cohorts' and persist placement audit snapshot
    await LeagueRolloverLog.updateMany(
      { weekKey, status: 'committed' },
      { $set: { currentStep: 'seed_next_cohorts' } },
    );
    if (placementsByOriginCohort.size > 0) {
      await LeagueRolloverLog.bulkWrite(
        [...placementsByOriginCohort.entries()].map(([originKey, cohortPlacements]) => {
          const [prevDiv, prevCohortId] = originKey.split(':') as [LeagueDivision, string];
          return {
            updateOne: {
              filter: { weekKey, division: prevDiv, cohortId: prevCohortId, status: 'committed' as const },
              update: { $set: { 'snapshot.nextWeekPlacements': cohortPlacements } },
            },
          };
        }),
      );
    }

    let assigned = 0;
    const seededEntries: Array<{ key: string; existedBefore: boolean; addedMembers: string[] }> = [];

    try {
      for (let i = 0; i < placements.length; i += WRITE_BATCH) {
        const batch = placements.slice(i, i + WRITE_BATCH);
        const writes = await LeagueStanding.bulkWrite(
          batch.map(p => ({
            updateOne: {
              filter: { weekKey: upcomingWeekKey, userId: new Types.ObjectId(p.userId) },
              update: {
                $setOnInsert: {
                  weekKey: upcomingWeekKey,
                  userId: new Types.ObjectId(p.userId),
                  division: p.division,
                  cohortId: p.cohortId,
                  status: 'active' as const,
                  joinedAt: upcomingStart,
                  points: 0,
                  rank: null,
                  cohortSize: null,
                  outcome: null,
                  nextDivision: null,
                  finalizedAt: null,
                  notifiedAt: null,
                },
              },
              upsert: true,
            },
          })),
        );
        assigned += writes.upsertedCount;
      }

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

      for (const [key, entry] of members) {
        const existedBefore = await this.store.exists(key);
        const addedMembers = entry.ids.filter((id) => newPlacementUserIdSet.has(id));
        seededEntries.push({ key, existedBefore, addedMembers });
        await this.store.seed(key, entry.ids);
      }

      await LeagueRolloverLog.updateMany(
        { weekKey, status: 'committed', currentStep: 'seed_next_cohorts' },
        { $set: { error: null } },
      );

      return { assigned };
    } catch (err) {
      const failureError = err instanceof Error ? err : new Error(String(err));
      const purgedRedisKeys: string[] = [];

      // Inverse compensation for Redis sorted sets seeded before failure
      for (const entry of seededEntries) {
        try {
          if (!entry.existedBefore) {
            await this.store.del(entry.key);
            purgedRedisKeys.push(entry.key);
          } else if (entry.addedMembers.length > 0) {
            await this.store.removeMany(entry.key, entry.addedMembers);
            purgedRedisKeys.push(entry.key);
          }
        } catch (cleanupErr) {
          logger.warn('[saga] Failed to clean up Redis cohort key during rollback', {
            event: 'league_next_week_redis_cleanup_failed',
            weekKey,
            upcomingWeekKey,
            key: entry.key,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        }
      }

      // Inverse compensation for MongoDB: remove only rows newly inserted by this run (never pre-existing rows)
      for (let i = 0; i < newPlacementUserIds.length; i += WRITE_BATCH) {
        const batch = newPlacementUserIds.slice(i, i + WRITE_BATCH);
        await LeagueStanding.deleteMany({
          weekKey: upcomingWeekKey,
          userId: { $in: batch.map(id => new Types.ObjectId(id)) },
        });
      }

      const rolledBackAt = new Date();
      // Reset cohort checkpoint logs from 'seed_next_cohorts' back to 'persist_standings' with rollback audit
      await LeagueRolloverLog.updateMany(
        { weekKey, status: 'committed', currentStep: 'seed_next_cohorts' },
        {
          $set: {
            currentStep: 'persist_standings',
            error: {
              message: failureError.message,
              step: 'seed_next_cohorts',
              occurredAt: rolledBackAt,
            },
            lastRollback: {
              phase: 'next_week_seeding',
              step: 'seed_next_cohorts',
              affectedUserIds: newPlacementUserIds,
              purgedRedisKeys,
              rolledBackAt,
              reason: failureError.message,
            },
          },
        },
      );

      this.emitRollbackTelemetry({
        phase: 'next_week_seeding',
        weekKey,
        upcomingWeekKey,
        division: 'all',
        cohortId: 'all',
        step: 'seed_next_cohorts',
        affectedUserIds: newPlacementUserIds,
        purgedRedisKeys,
        error: failureError,
      });

      throw err;
    }
  }

  /**
   * Processes a single cohort through the forward saga steps. If any step fails,
   * executes inverse compensation on all previously executed steps in reverse order.
   * Uses atomic acquisition to guarantee race-free concurrency across distributed workers.
   */
  private async processCohortWithSaga(
    weekKey: string,
    upcomingWeekKey: string,
    division: LeagueDivision,
    cohortId: string,
  ): Promise<SagaCohortExecutionResult> {
    const idempotencyKey = `rollover:${weekKey}:${division}:${cohortId}`;
    const leaseCutoff = new Date(Date.now() - this.stalledLeaseTimeoutMs);
    let log: ILeagueRolloverLog | null = null;

    const acquireUpdate = {
      $setOnInsert: {
        weekKey,
        division,
        cohortId,
        idempotencyKey,
      },
      $set: {
        status: 'in_progress',
        currentStep: 'snapshot_scores',
        startedAt: this.now,
        error: null,
      },
      $inc: { attempts: 1 },
    };

    // 1. Atomic lock acquisition first (eliminates TOCTOU between pre-lock read and lock write).
    // Only claim non-committed states or expired leases; committed logs are never blindly overwritten.
    try {
      log = await LeagueRolloverLog.findOneAndUpdate(
        {
          idempotencyKey,
          $or: [
            { status: { $in: ['pending', 'compensated', 'failed'] } },
            { status: 'in_progress', updatedAt: { $lte: leaseCutoff } },
          ],
        },
        acquireUpdate,
        { upsert: true, new: true, returnDocument: 'after' },
      );
    } catch (err: any) {
      // If a concurrent upsert race occurred on unique key (or doc already exists in committed/in_progress state),
      // leave log as null and fall through to step 2 to inspect committed/partial state safely.
      if (err?.code === 11000 || err?.message?.includes('E11000')) {
        logger.debug(`[saga] Concurrent upsert/existing doc on ${idempotencyKey}, checking committed state`);
        log = null;
      } else {
        throw err;
      }
    }

    // 2. If not acquired, check if it's already committed (and whether any active rows remain from a partial run)
    if (!log) {
      const existing = await LeagueRolloverLog.findOne({ idempotencyKey }).lean();
      if (existing?.status === 'committed') {
        const activeCount = await LeagueStanding.countDocuments({ weekKey, division, cohortId, status: 'active' });
        if (activeCount === 0) {
          return {
            cohortId,
            division,
            status: 'skipped',
            finalizedCount: 0,
            promotedCount: 0,
            demotedCount: 0,
          };
        }
        // Partial run recovery: atomically transition committed -> in_progress so only one worker recovers it
        log = await LeagueRolloverLog.findOneAndUpdate(
          { idempotencyKey, status: 'committed' },
          acquireUpdate,
          { new: true, returnDocument: 'after' },
        );
      }
    }

    // If query condition still did not match (another live worker holds the unexpired lease or won the recovery race)
    if (!log) {
      logger.info(`[saga] Cohort ${division}:${cohortId} is actively leased or already handled by another worker; skipping concurrent execution.`);
      return {
        cohortId,
        division,
        status: 'skipped',
        finalizedCount: 0,
        promotedCount: 0,
        demotedCount: 0,
      };
    }

    // 3. Double-checked verification inside lock boundary: if no active standings remain, commit & skip
    const activeInsideLock = await LeagueStanding.countDocuments({ weekKey, division, cohortId, status: 'active' });
    if (activeInsideLock === 0) {
      log.status = 'committed';
      log.completedAt = new Date();
      await log.save();
      return {
        cohortId,
        division,
        status: 'skipped',
        finalizedCount: 0,
        promotedCount: 0,
        demotedCount: 0,
      };
    }

    const ctx: SagaCohortContext = {
      weekKey,
      upcomingWeekKey,
      division,
      cohortId,
      store: this.store,
      now: this.now,
      log,
    };

    const executedSteps: ISagaStep[] = [];
    let failedStep: ISagaStep | null = null;
    let failureError: Error | null = null;

    for (const step of sagaCohortSteps) {
      try {
        log.currentStep = step.name;
        await log.save();

        await step.execute(ctx);
        executedSteps.push(step);
      } catch (err) {
        failedStep = step;
        failureError = err instanceof Error ? err : new Error(String(err));
        logger.error(`[saga] Step '${step.name}' failed for cohort ${division}:${cohortId}`, failureError);
        break;
      }
    }

    if (failureError) {
      // Include the failed step itself so partial writes inside it are also compensated idempotently
      const stepsToCompensate = failedStep ? [...executedSteps, failedStep] : executedSteps;
      await this.compensateExecutedSteps(stepsToCompensate, ctx, failureError);
      return {
        cohortId,
        division,
        status: 'compensated',
        finalizedCount: 0,
        promotedCount: 0,
        demotedCount: 0,
        error: failureError.message,
      };
    }

    // All steps succeeded cleanly: commit cohort
    log.status = 'committed';
    log.completedAt = new Date();
    await log.save();

    const outcomes = ctx.outcomes ?? [];
    const modifiedCount = ctx.modifiedCount ?? outcomes.length;
    return {
      cohortId,
      division,
      status: 'committed',
      finalizedCount: modifiedCount,
      promotedCount: modifiedCount > 0 ? outcomes.filter(o => o.outcome === 'promoted').length : 0,
      demotedCount: modifiedCount > 0 ? outcomes.filter(o => o.outcome === 'demoted').length : 0,
      finalizedStandings: modifiedCount > 0 ? outcomes.map(s => ({ ...s, division })) : [],
    };
  }

  /**
   * Compensates all executed steps in reverse order.
   */
  private async compensateExecutedSteps(
    executedSteps: ISagaStep[],
    ctx: SagaCohortContext,
    error: Error,
  ): Promise<void> {
    const affectedUserIds =
      ctx.affectedUserIds && ctx.affectedUserIds.length > 0
        ? ctx.affectedUserIds
        : (ctx.log.snapshot?.previousStandings?.map(s => s.userId) ?? []);

    for (const step of [...executedSteps].reverse()) {
      try {
        await step.compensate(ctx);
      } catch (compErr) {
        logger.error(`[saga] Compensation failed at step '${step.name}' for ${ctx.log.idempotencyKey}`, compErr);
      }
    }

    const rolledBackAt = new Date();
    ctx.log.status = 'compensated';
    ctx.log.compensatedAt = rolledBackAt;
    ctx.log.error = {
      message: error.message,
      step: ctx.log.currentStep,
      occurredAt: rolledBackAt,
      stack: error.stack,
    };
    ctx.log.lastRollback = {
      phase: 'cohort_finalization',
      step: ctx.log.currentStep,
      affectedUserIds,
      purgedRedisKeys: [],
      rolledBackAt,
      reason: error.message,
    };
    await ctx.log.save();

    this.emitRollbackTelemetry({
      phase: 'cohort_finalization',
      weekKey: ctx.weekKey,
      upcomingWeekKey: ctx.upcomingWeekKey,
      division: ctx.division,
      cohortId: ctx.cohortId,
      step: ctx.log.currentStep,
      affectedUserIds,
      purgedRedisKeys: [],
      error,
    });
  }

  private emitRollbackTelemetry(params: {
    phase: 'cohort_finalization' | 'next_week_seeding';
    weekKey: string;
    upcomingWeekKey: string;
    division: string;
    cohortId: string;
    step: string;
    affectedUserIds: string[];
    purgedRedisKeys: string[];
    error: Error;
  }): void {
    const timestamp = new Date().toISOString();
    const payload = {
      weekKey: params.weekKey,
      upcomingWeekKey: params.upcomingWeekKey,
      phase: params.phase,
      division: params.division,
      cohortId: params.cohortId,
      step: params.step,
      affectedUsers: params.affectedUserIds.length,
      affectedUserIds: params.affectedUserIds,
      purgedRedisKeys: params.purgedRedisKeys,
      error: params.error.message,
      timestamp,
    };

    logger.error('[saga] League rollover saga rollback executed', {
      event: 'league_saga_rollback',
      ...payload,
    });
    leagueSagaRollbacks.inc({
      phase: params.phase,
      division: params.division,
      step: params.step,
    });
    eventBus.emit('league.saga_rollback', payload);
    eventBus.publish({
      type: 'league.saga_rollback' as any,
      timestamp,
      payload,
    });
  }

  /**
   * Recovers cohorts left in 'in_progress' status from previous crashed workers whose lease has expired.
   * Live workers with active leases are not disrupted.
   */
  private async recoverStalledCohorts(weekKey: string, upcomingWeekKey: string): Promise<number> {
    const leaseCutoff = new Date(Date.now() - this.stalledLeaseTimeoutMs);
    const stalledLogs = await LeagueRolloverLog.find({
      weekKey,
      status: 'in_progress',
      updatedAt: { $lte: leaseCutoff },
    });

    if (stalledLogs.length === 0) return 0;

    logger.warn(`[saga] Found ${stalledLogs.length} stalled cohorts from previous aborted run; rolling back...`);

    for (const log of stalledLogs) {
      const ctx: SagaCohortContext = {
        weekKey,
        upcomingWeekKey,
        division: log.division,
        cohortId: log.cohortId,
        store: this.store,
        now: this.now,
        log,
        affectedUserIds: log.snapshot?.standings?.map(s => s.userId) ?? [],
      };

      // Compensate all possible steps in reverse order to ensure clean baseline
      await this.compensateExecutedSteps(sagaCohortSteps, ctx, new Error('Recovered from interrupted crash'));
    }

    return stalledLogs.length;
  }
}
