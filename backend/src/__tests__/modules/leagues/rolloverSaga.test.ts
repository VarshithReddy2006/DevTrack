// backend/src/__tests__/modules/leagues/rolloverSaga.test.ts
// Comprehensive integration and adversarial failure-injection tests for the
// Two-Phase Commit Saga Orchestrator for weekly league cohort rollover.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import {
  LeagueStanding,
  LeagueRolloverLog,
  UserSettings,
  type LeagueDivision,
} from '../../../db/models/index.js';
import { cohortKey } from '../../../modules/leagues/leagues.constants.js';
import {
  joinCurrentWeek,
  recordXpAward,
} from '../../../modules/leagues/leagues.service.js';
import {
  runWeeklyRollover,
  RolloverSagaOrchestrator,
  type WeekFinalizedPayload,
} from '../../../modules/leagues/rollover.js';
import { eventBus } from '../../../shared/sse/index.js';
import { FakeScoreStore } from './fakeScoreStore.js';

const WEEK = '2026-11-15';
const NEXT = '2026-11-22';
const MID_WEEK = new Date('2026-11-18T12:00:00.000Z');
const ROLLOVER_AT = new Date('2026-11-22T00:00:05.000Z');

let store: FakeScoreStore;
let counter = 0;

beforeEach(async () => {
  store = new FakeScoreStore();
  counter = 0;
  vi.restoreAllMocks();
  await LeagueStanding.deleteMany({});
  await LeagueRolloverLog.deleteMany({});
  await UserSettings.deleteMany({});
});

async function makeUsers(n: number, participate = true): Promise<string[]> {
  const ids = Array.from({ length: n }, () => new Types.ObjectId());
  await UserSettings.insertMany(ids.map(userId => ({ userId, leagues: { participate } })));
  return ids.map(id => id.toString());
}

async function makeCohort(division: LeagueDivision, cohortId: string, size = 10): Promise<string[]> {
  const ids = await makeUsers(size);
  await LeagueStanding.insertMany(
    ids.map(id => ({
      weekKey: WEEK,
      userId: new Types.ObjectId(id),
      division,
      cohortId,
      status: 'active' as const,
      joinedAt: new Date('2026-11-15T01:00:00Z'),
      points: 0,
      rank: null,
      cohortSize: null,
      outcome: null,
      nextDivision: null,
      finalizedAt: null,
    })),
  );
  for (const [i, id] of ids.entries()) {
    const points = (i + 1) * 10;
    await recordXpAward(
      { userId: id, sourceType: 'dsa_accepted', sourceId: `src-${++counter}`, xpAwarded: points, occurredAt: MID_WEEK },
      store,
      MID_WEEK,
    );
  }
  return ids;
}

const row = (userId: string, weekKey: string) =>
  LeagueStanding.findOne({ weekKey, userId: new Types.ObjectId(userId) }).lean();

describe('RolloverSagaOrchestrator — Adversarial Integration Tests', () => {
  it('happy path: executes multi-cohort rollover with durable checkpoint logging and event emission', async () => {
    const goldIds = await makeCohort('gold', 'c1', 10);
    const silverIds = await makeCohort('silver', 'c1', 10);

    const eventListener = vi.fn();
    eventBus.on('league.rollover_completed', eventListener);

    const result = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT });

    expect(result).toMatchObject({
      weekKey: WEEK,
      nextWeekKey: NEXT,
      finalized: 20,
      promoted: 4, // 2 from gold, 2 from silver
      demoted: 4,  // 2 from gold, 2 from silver
      assigned: 20,
      compensatedCohorts: 0,
      stalledRecovered: 0,
    });

    // Checkpoint ledger verification in LeagueRolloverLog
    const logs = await LeagueRolloverLog.find({ weekKey: WEEK }).sort({ division: 1 });
    expect(logs).toHaveLength(2);

    for (const log of logs) {
      expect(log.status).toBe('committed');
      expect(log.currentStep).toBe('seed_next_cohorts');
      expect(log.attempts).toBe(1);
      expect(log.error).toBeNull();
      expect(log.snapshot?.board.length).toBe(10);
      expect(log.snapshot?.standings.length).toBe(10);
    }

    // Verify next-week records exist and Redis was seeded
    const nextWeekRows = await LeagueStanding.find({ weekKey: NEXT });
    expect(nextWeekRows).toHaveLength(20);
    for (const r of nextWeekRows) {
      expect(r.status).toBe('active');
      expect(r.points).toBe(0);
    }

    // Verify lifecycle completion event emission
    expect(eventListener).toHaveBeenCalledTimes(1);
    expect(eventListener).toHaveBeenCalledWith(
      expect.objectContaining({
        weekKey: WEEK,
        upcomingWeekKey: NEXT,
        totalFinalized: 20,
        totalAssigned: 20,
      }),
    );

    eventBus.off('league.rollover_completed', eventListener);
  });

  it('idempotency: re-executing rollover on committed cohorts is a safe no-op without duplicate rows', async () => {
    const ids = await makeCohort('gold', 'c1', 10);

    // Initial run
    const result1 = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT });
    expect(result1.finalized).toBe(10);
    expect(result1.assigned).toBe(10);

    // Re-execution
    const result2 = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT });
    expect(result2.finalized).toBe(0);
    expect(result2.assigned).toBe(0);
    expect(result2.compensatedCohorts).toBe(0);

    // Verify exactly 10 rows exist for WEEK and 10 rows for NEXT
    const weekCount = await LeagueStanding.countDocuments({ weekKey: WEEK });
    const nextCount = await LeagueStanding.countDocuments({ weekKey: NEXT });
    expect(weekCount).toBe(10);
    expect(nextCount).toBe(10);

    // Checkpoint ledger remains committed with attempts = 1
    const logs = await LeagueRolloverLog.find({ weekKey: WEEK });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('committed');
  });

  it('mid-saga failure at persist_standings triggers inverse compensation and preserves database consistency', async () => {
    const ids = await makeCohort('silver', 'c1', 10);

    // Spy on LeagueStanding.bulkWrite to simulate database write failure during persist_standings
    const originalBulkWrite = LeagueStanding.bulkWrite.bind(LeagueStanding);
    let failOnce = true;
    vi.spyOn(LeagueStanding, 'bulkWrite').mockImplementation(async (ops: any[], options?: any) => {
      // Check if this bulkWrite is the standings persistence
      if (failOnce && ops?.[0]?.updateOne?.update?.$set?.status === 'finalized') {
        failOnce = false;
        throw new Error('Database disk full / network partition during persist_standings');
      }
      return originalBulkWrite(ops, options);
    });

    const eventListener = vi.fn();
    eventBus.on('league.rollover_completed', eventListener);

    const result = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT });

    // Should report compensated failure
    expect(result.compensatedCohorts).toBe(1);
    expect(result.finalized).toBe(0);
    expect(result.assigned).toBe(0);
    expect(result.cohortResults[0]).toMatchObject({
      cohortId: 'c1',
      division: 'silver',
      status: 'compensated',
      error: 'Database disk full / network partition during persist_standings',
    });

    // Inverse compensation: all rows must still be active with 0 finalized
    const activeRows = await LeagueStanding.find({ weekKey: WEEK, status: 'active' });
    expect(activeRows).toHaveLength(10);
    const finalizedRows = await LeagueStanding.find({ weekKey: WEEK, status: 'finalized' });
    expect(finalizedRows).toHaveLength(0);

    // Ledger records compensated state with step and error
    const log = await LeagueRolloverLog.findOne({ weekKey: WEEK, division: 'silver', cohortId: 'c1' });
    expect(log).not.toBeNull();
    expect(log?.status).toBe('compensated');
    expect(log?.currentStep).toBe('persist_standings');
    expect(log?.error?.message).toContain('Database disk full');

    // Lifecycle completion event must NOT be emitted on compensation
    expect(eventListener).not.toHaveBeenCalled();

    // Now restore bulkWrite and retry: should recover cleanly
    vi.restoreAllMocks();

    const retryResult = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT });
    expect(retryResult.finalized).toBe(10);
    expect(retryResult.assigned).toBe(10);
    expect(retryResult.compensatedCohorts).toBe(0);

    // Ledger should now be committed
    const recoveredLog = await LeagueRolloverLog.findOne({ weekKey: WEEK, division: 'silver', cohortId: 'c1' });
    expect(recoveredLog?.status).toBe('committed');
    expect(recoveredLog?.attempts).toBe(2);

    eventBus.off('league.rollover_completed', eventListener);
  });

  it('mid-saga failure at seed_next_cohorts rolls back partial next-week records and recovers cleanly on retry', async () => {
    const ids = await makeCohort('gold', 'c1', 10);

    // Simulate Redis failure during next-week seeding
    const originalSeed = store.seed.bind(store);
    let failSeed = true;
    vi.spyOn(store, 'seed').mockImplementation(async (key: string, memberIds: string[]) => {
      if (failSeed && key.startsWith(cohortKey(NEXT, 'gold', 'c1')) || key.includes(NEXT)) {
        failSeed = false;
        throw new Error('Redis connection drop during next-week board seeding');
      }
      return originalSeed(key, memberIds);
    });

    // First attempt: should fail during seedNextWeekCohorts and rollback upcoming standings
    await expect(runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT })).rejects.toThrow(
      'Redis connection drop during next-week board seeding',
    );

    // Standings for current week were finalized cleanly
    const weekFinalized = await LeagueStanding.find({ weekKey: WEEK, status: 'finalized' });
    expect(weekFinalized).toHaveLength(10);

    // But upcoming week standings must be cleanly rolled back (0 rows) to prevent orphan state
    const nextWeekRows = await LeagueStanding.find({ weekKey: NEXT });
    expect(nextWeekRows).toHaveLength(0);

    // Now restore store.seed and re-run (simulating retry worker or scheduled resume)
    vi.restoreAllMocks();

    const recoverResult = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT });
    expect(recoverResult.finalized).toBe(0); // already finalized
    expect(recoverResult.assigned).toBe(10); // cleanly assigned on retry

    // Upcoming week now has exactly 10 rows and no duplicates
    const recoveredNextRows = await LeagueStanding.find({ weekKey: NEXT });
    expect(recoveredNextRows).toHaveLength(10);
  });

  it('crash recovery: safely reconciles stalled cohorts left in in_progress status by crashed workers', async () => {
    const ids = await makeCohort('gold', 'c1', 10);

    // Simulate an aborted/crashed worker with an expired lease
    await LeagueRolloverLog.create({
      weekKey: WEEK,
      division: 'gold',
      cohortId: 'c1',
      idempotencyKey: `rollover:${WEEK}:gold:c1`,
      status: 'in_progress',
      currentStep: 'persist_standings',
      attempts: 1,
      startedAt: new Date('2026-11-22T00:00:01.000Z'),
    });

    // Also simulate that 3 of the 10 users were marked 'finalized' by the crashed worker before dying
    await LeagueStanding.updateMany(
      { weekKey: WEEK, userId: { $in: ids.slice(0, 3).map(id => new Types.ObjectId(id)) } },
      { $set: { status: 'finalized', finalizedAt: ROLLOVER_AT } },
    );

    // Run rollover with stalledLeaseTimeoutMs: 0 to force immediate crash recovery
    const result = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, stalledLeaseTimeoutMs: 0 });

    // Should detect stalled cohort, compensate the aborted state, and then process cleanly
    expect(result.stalledRecovered).toBe(1);
    expect(result.finalized).toBe(10);
    expect(result.assigned).toBe(10);

    // Checkpoint ledger is now committed
    const log = await LeagueRolloverLog.findOne({ weekKey: WEEK, division: 'gold', cohortId: 'c1' });
    expect(log?.status).toBe('committed');
  });

  it('concurrency: parallel workers racing on the same cohort execute safely without errors or split-brain', async () => {
    const ids = await makeCohort('diamond', 'c1', 10);

    // Launch two workers simultaneously against the same week and cohort
    const [resultA, resultB] = await Promise.all([
      runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT }),
      runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT }),
    ]);

    // One worker executes and finalizes the cohort; the other skips cleanly
    const totalFinalized = resultA.finalized + resultB.finalized;
    expect(totalFinalized).toBe(10);

    // Exactly 10 rows in WEEK finalized, exactly 10 rows in NEXT created
    const weekCount = await LeagueStanding.countDocuments({ weekKey: WEEK, status: 'finalized' });
    const nextCount = await LeagueStanding.countDocuments({ weekKey: NEXT, status: 'active' });
    expect(weekCount).toBe(10);
    expect(nextCount).toBe(10);

    // Checkpoint ledger committed with exactly 1 entry and no duplicate key errors
    const logs = await LeagueRolloverLog.find({ weekKey: WEEK, division: 'diamond', cohortId: 'c1' });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('committed');
  });

  it('lease protection: active running worker within lease window is NOT rolled back by concurrent recovery', async () => {
    const ids = await makeCohort('platinum', 'c1', 10);

    // Simulate an actively running worker whose lease has NOT expired (lease window 60s)
    await LeagueRolloverLog.create({
      weekKey: WEEK,
      division: 'platinum',
      cohortId: 'c1',
      idempotencyKey: `rollover:${WEEK}:platinum:c1`,
      status: 'in_progress',
      currentStep: 'snapshot_scores',
      attempts: 1,
      startedAt: new Date(),
    });

    // Run rollover with stalledLeaseTimeoutMs: 60,000 (1 minute)
    const result = await runWeeklyRollover(WEEK, { store, now: ROLLOVER_AT, stalledLeaseTimeoutMs: 60_000 });

    // Active worker must NOT be considered stalled or rolled back
    expect(result.stalledRecovered).toBe(0);

    // Cohort should be skipped by the second worker since active lease is held
    const log = await LeagueRolloverLog.findOne({ weekKey: WEEK, division: 'platinum', cohortId: 'c1' });
    expect(log?.status).toBe('in_progress');
  });
});
