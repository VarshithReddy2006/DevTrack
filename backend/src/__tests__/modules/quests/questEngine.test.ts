import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { User } from '../../../db/models/user.model.js';
import { Quest } from '../../../db/models/quest.model.js';
import { UserQuestProgress } from '../../../db/models/userQuestProgress.model.js';
import { LeagueStanding, LEAGUE_DIVISIONS } from '../../../db/models/leagueStanding.model.js';
import { UserXp } from '../../../db/models/userXp.model.js';
import { UserAnalytics } from '../../../db/models/userAnalytics.model.js';
import { XpTransaction } from '../../../db/models/xpTransaction.model.js';
import { ProcessedEvent } from '../../../db/models/processedEvent.model.js';
import { OutboxEvent } from '../../../db/models/outboxEvent.model.js';
import { DsaProblem } from '../../../db/models/dsaProblem.model.js';
import { DsaSubmission } from '../../../db/models/dsaSubmission.model.js';
import { FocusSession } from '../../../db/models/focusSession.model.js';
import { RevisionCard } from '../../../db/models/revisionCard.model.js';
import {
  QUEST_SWEEP_BATCH_SIZE,
  QUEST_SWEEP_CHECKPOINT_PREFIX,
  QUEST_SWEEP_CHECKPOINT_TTL_SECONDS,
  QUEST_SWEEP_CONCURRENCY,
  executeQuestGenerationSweep,
  generateUserQuests,
  listUserQuests,
  questDefinitions,
  questPeriods,
  runQuestGenerationSweep,
  type SweepRedisClient,
} from '../../../modules/quests/questEngine.service.js';
import { registerQuestConsumers, trackQuestEvent, questNotificationConsumer } from '../../../modules/quests/questEvents.consumer.js';
import { processQuestReward } from '../../../modules/xp/processor.js';
import { RevisionService } from '../../../modules/revision/revision.service.js';
import { scheduleQuestGeneration } from '../../../modules/quests/questScheduler.js';
import { questRoutes } from '../../../modules/quests/quest.routes.js';
import { mountApiRoutes } from '../../../routes/mount.js';
import { errorHandler } from '../../../middleware/error.js';
import { consumerRegistry, clearConsumerRegistry } from '../../../shared/events/consumerRegistry.js';
import { processDomainReadinessJob } from '../../../modules/readiness/workers/domainReadiness.worker.js';
import { createDomainOutboxRelay } from '../../../workers/focus-completion.worker.js';
import { createDomainEvent, type DomainEventEnvelope } from '../../../shared/events/eventContract.js';
import { toEnvelope } from '../../../shared/events/outboxRelay.js';
import { weekKeyFor } from '../../../modules/leagues/weeks.js';

vi.mock('../../../shared/redis/client.js', () => ({
  isRedisConfigured: fixtures.isRedisConfigured,
  getRedisClient: fixtures.getRedisClient,
}));

const fixtures = vi.hoisted(() => ({
  isRedisConfigured: vi.fn(() => false),
  getRedisClient: vi.fn(),
  
  publish: vi.fn().mockResolvedValue(undefined), league: vi.fn().mockResolvedValue(undefined),
  cache: vi.fn().mockResolvedValue(undefined), runtime: vi.fn().mockResolvedValue(undefined),
  owner: '111111111111111111111111', limited: false,
}));
vi.mock('../../../shared/sse/eventBus.js', () => ({ eventBus: {
  publishEnvelope: fixtures.publish, publish: vi.fn(), emitXpUpdated: vi.fn(), emitLevelUp: vi.fn(),
} }));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: {
  publishEnvelope: fixtures.publish, publish: vi.fn(), emitXpUpdated: vi.fn(), emitLevelUp: vi.fn(),
} }));
vi.mock('../../../modules/leagues/workers/leagueScore.worker.js', () => ({ enqueueLeagueScore: fixtures.league }));
vi.mock('../../../shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateAllUserCache: fixtures.cache } }));
vi.mock('../../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { updateFromEvent: fixtures.runtime } }));
vi.mock('../../../middleware/auth.js', () => ({ authMiddleware: (req: express.Request & { user?: { id: string } }, res: express.Response, next: express.NextFunction) => {
  if (req.get('authorization') !== 'Bearer fixture') { res.sendStatus(401); return; }
  req.user = { id: fixtures.owner }; next();
} }));
vi.mock('../../../middleware/rateLimitAdvanced.js', () => ({ rateLimiters: { xp: (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (fixtures.limited) { res.sendStatus(429); return; } next();
} } }));
vi.mock('../../../shared/monitoring.js', () => ({ reportError: vi.fn() }));

let now: Date;
let sequence = 0;
const userId = fixtures.owner;
beforeAll(async () => {
  for (const model of [User, Quest, UserQuestProgress, LeagueStanding, UserXp, UserAnalytics, XpTransaction, ProcessedEvent, OutboxEvent, DsaProblem, DsaSubmission, FocusSession, RevisionCard]) {
    await model.init();
  }
});
beforeEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); clearConsumerRegistry();
  fixtures.publish.mockResolvedValue(undefined); fixtures.league.mockResolvedValue(undefined);
  fixtures.cache.mockResolvedValue(undefined); fixtures.runtime.mockResolvedValue(undefined);
  fixtures.limited = false;
  now = new Date();
  await User.create({ _id: userId, clerkId: 'quest-test', email: 'quest@example.test', username: 'quest-tester', displayName: 'Quest Tester' });
});
function event(type: string, payload: Record<string, unknown>, owner = userId): DomainEventEnvelope {
  return { id: randomUUID(), type, schemaVersion: 1, userId: owner, timestamp: now.toISOString(), correlationId: randomUUID(), causationId: randomUUID(), payload };
}
async function solve(at = now, owner = userId) {
  const externalId = 'quest-' + (++sequence);
  const problem = await DsaProblem.create({ userId: owner, externalId, problemKey: 'leetcode:' + externalId, platform: 'leetcode',
    title: 'Array problem', difficulty: 'medium', category: 'arrays', tags: ['array'], url: 'https://example.test/' + externalId, status: 'solved', solvedAt: at });
  const submission = await DsaSubmission.create({ userId: owner, problemId: problem._id, platform: 'leetcode', externalId,
    status: 'accepted', language: 'typescript', submittedAt: at });
  return { problem, submission, envelope: event('dsa.submission.evaluated', { submissionId: submission._id.toString() }, owner) };
}
async function focus(minutes = 30, coverage = minutes) {
  return FocusSession.create({ userId, mode: 'deep_work', status: 'completed', completedAt: now,
    plannedDurationMinutes: minutes, plannedSec: minutes * 60, activeDurationMs: minutes * 60_000, coveredHeartbeatIntervals: coverage });
}
async function eligible() {
  const rows = await generateUserQuests(userId, now);
  const row = rows.find(item => item.slot === 'daily:dsa_solve')!;
  await UserQuestProgress.updateOne({ _id: row._id }, { $set: { currentCount: row.targetCount, completed: true, completedAt: now } });
  return row;
}

describe('quest generation and period rules', () => {
  it('creates exactly three daily and two weekly quests and preserves progress on retries', async () => {
    const rows = await generateUserQuests(userId, now);
    expect(rows.filter(item => item.cadence === 'daily')).toHaveLength(3);
    expect(rows.filter(item => item.cadence === 'weekly')).toHaveLength(2);
    await UserQuestProgress.updateOne({ _id: rows[0]._id }, { $set: { currentCount: 1 } });
    await generateUserQuests(userId, now);
    expect(await UserQuestProgress.countDocuments({ userId })).toBe(5);
    expect((await UserQuestProgress.findById(rows[0]._id))!.currentCount).toBe(1);
  });
  it.each(LEAGUE_DIVISIONS)('scales targets and rewards for %s', async division => {
    await LeagueStanding.create({ userId, weekKey: weekKeyFor(now), division, cohortId: '1', joinedAt: now });
    const rows = await generateUserQuests(userId, now);
    expect(rows.every(row => row.division === division)).toBe(true);
    expect(rows.find(row => row.slot === 'daily:dsa_solve')!.targetCount).toBe(2 + LEAGUE_DIVISIONS.indexOf(division));
    expect(questDefinitions(division).every(row => Number.isSafeInteger(row.xpReward) && row.xpReward > 0)).toBe(true);
  });
  it('uses promotion history when no current standing exists', async () => {
    await LeagueStanding.create({ userId, weekKey: '2026-11-08', division: 'silver', nextDivision: 'gold', status: 'finalized', cohortId: '1', joinedAt: now });
    expect((await generateUserQuests(userId, now)).every(row => row.division === 'gold')).toBe(true);
  });
  it('waits for the prior league week to finalize instead of freezing the wrong tier at Sunday midnight', async () => {
    const sunday = new Date('2026-11-22T00:00:00Z');
    await LeagueStanding.create({ userId, weekKey: '2026-11-15', division: 'silver', status: 'active', cohortId: '1', joinedAt: now });
    await expect(generateUserQuests(userId, sunday)).rejects.toMatchObject({ statusCode: 503 });
    expect(await UserQuestProgress.countDocuments()).toBe(0);
    await LeagueStanding.updateOne({ userId }, { $set: { status: 'finalized', nextDivision: 'gold' } });
    expect((await generateUserQuests(userId, sunday)).every(row => row.division === 'gold')).toBe(true);
  });
  it('prevents extra or reset slots when a division changes mid-period', async () => {
    const first = await generateUserQuests(userId, now);
    await LeagueStanding.create({ userId, weekKey: weekKeyFor(now), division: 'diamond', cohortId: '1', joinedAt: now });
    const second = await generateUserQuests(userId, now);
    expect(second.map(row => row._id.toString())).toEqual(first.map(row => row._id.toString()));
    expect(second.every(row => row.division === 'bronze')).toBe(true);
  });
  it('deduplicates concurrent first-time generation', async () => {
    await Promise.all(Array.from({ length: 6 }, () => generateUserQuests(userId, now)));
    expect(await UserQuestProgress.countDocuments({ userId })).toBe(5);
    expect(await Quest.countDocuments()).toBe(5);
  });
  it('serializes concurrent generateUserQuests callers using Redis SET NX PX lock and releases lock on completion', async () => {
    const heldLocks = new Map<string, string>();
    const mockRedis = {
      set: vi.fn(async (key: string, token: string, _px: string, _ttl: number, _nx: string) => {
        if (heldLocks.has(key)) return null;
        heldLocks.set(key, token);
        return 'OK';
      }),
      eval: vi.fn(async (_lua: string, _numKeys: number, key: string, token: string) => {
        if (heldLocks.get(key) === token) {
          heldLocks.delete(key);
          return 1;
        }
        return 0;
      }),
    };

    fixtures.isRedisConfigured.mockReturnValue(true);
    fixtures.getRedisClient.mockReturnValue(mockRedis);
    try {
      const results = await Promise.all(Array.from({ length: 5 }, () => generateUserQuests(userId, now)));
      expect(results.every(rows => rows.length === 5)).toBe(true);
      expect(await UserQuestProgress.countDocuments({ userId })).toBe(5);
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining(`quest-gen:${userId}:`),
        expect.any(String),
        'PX',
        5000,
        'NX',
      );
      expect(mockRedis.eval).toHaveBeenCalled();
      expect(heldLocks.size).toBe(0);
    } finally {
      fixtures.isRedisConfigured.mockReturnValue(false);
    }
  });
  it('uses half-open UTC days and Sunday weeks including year boundaries', () => {
    const last = questPeriods(new Date('2026-12-31T23:59:59.999Z'));
    const next = questPeriods(new Date('2027-01-01T00:00:00Z'));
    expect(last.daily.expiresAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(next.daily.periodKey).toBe('daily:2027-01-01');
    expect(next.weekly.periodKey).toBe('weekly:2026-12-27');
    expect(questPeriods(new Date('2027-01-03T00:00:00Z')).weekly.periodKey).toBe('weekly:2027-01-03');
  });
  it('creates a new daily set without resetting the current weekly set', async () => {
    const day = new Date('2026-11-18T23:59:59Z');
    await generateUserQuests(userId, day);
    await generateUserQuests(userId, new Date('2026-11-19T00:00:00Z'));
    expect(await UserQuestProgress.countDocuments()).toBe(8);
  });
  it('exposes owned instance IDs, expiry, rewards, progress, and trophy balance', async () => {
    const view = await listUserQuests(userId, now);
    expect(view.quests).toHaveLength(5); expect(view.leagueTrophies).toBe(0);
    expect(view.quests[0].questId).toMatch(/^[a-f0-9]{24}$/);
    expect(view.quests[0].definitionId).not.toBe(view.quests[0].questId);
  });
  it('runs the all-user catch-up sweep without duplicating prior allocations', async () => {
    await generateUserQuests(userId, now);
    expect(await runQuestGenerationSweep(now)).toEqual({ users: 1 });
    expect(await UserQuestProgress.countDocuments()).toBe(5);
  });

  it('paginates with keyset cursors, bounds concurrency, and clears the checkpoint on completion', async () => {
    const extraUsers = await Promise.all(
      Array.from({ length: 6 }, (_, idx) =>
        User.create({
          _id: new Types.ObjectId(),
          clerkId: `sweep-user-${idx}`,
          email: `sweep-${idx}@example.test`,
          username: `sweep-user-${idx}`,
          displayName: `Sweep User ${idx}`,
        })
      )
    );
    const allIds = [userId, ...extraUsers.map(u => u._id.toString())].sort();

    const store = new Map<string, { value: string; ttlSeconds: number }>();
    const setCalls: Array<{ key: string; value: string; ttlSeconds: number }> = [];
    const redisClient: SweepRedisClient = {
      status: 'ready',
      get: vi.fn(async (key: string) => store.get(key)?.value ?? null) as unknown as SweepRedisClient['get'],
      set: vi.fn(async (key: string, value: string, _mode?: unknown, ttl?: unknown) => {
        const ttlSeconds = Number(ttl ?? 0);
        store.set(key, { value, ttlSeconds });
        setCalls.push({ key, value, ttlSeconds });
        return 'OK';
      }) as unknown as SweepRedisClient['set'],
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)) as unknown as SweepRedisClient['del'],
    };

    let inFlight = 0;
    let maxInFlight = 0;
    const processedOrder: string[] = [];

    const report = await executeQuestGenerationSweep(now, {
      batchSize: 3,
      concurrency: 2,
      redisClient,
      processUser: async (uid, at) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 10));
        try {
          processedOrder.push(uid);
          return await generateUserQuests(uid, at);
        } finally {
          inFlight--;
        }
      },
    });

    expect(QUEST_SWEEP_BATCH_SIZE).toBe(250);
    expect(QUEST_SWEEP_CONCURRENCY).toBe(10);
    expect(report).toMatchObject({
      users: 7,
      failed: 0,
      batches: 3,
      resumedFromUserId: null,
      completed: true,
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect([...processedOrder].sort()).toEqual(allIds);
    expect(await UserQuestProgress.countDocuments()).toBe(35);

    const expectedKey = `${QUEST_SWEEP_CHECKPOINT_PREFIX}:${questPeriods(now).daily.periodKey}`;
    expect(setCalls).toHaveLength(3);
    expect(setCalls.every(call => call.key === expectedKey && call.ttlSeconds === QUEST_SWEEP_CHECKPOINT_TTL_SECONDS)).toBe(true);
    expect(JSON.parse(setCalls[0].value).lastUserId).toBe(allIds[2]);
    expect(JSON.parse(setCalls[1].value).lastUserId).toBe(allIds[5]);
    expect(JSON.parse(setCalls[2].value).lastUserId).toBe(allIds[6]);
    expect(store.has(expectedKey)).toBe(false);
  });

  it('resumes from the last Redis checkpoint after a batch failure without reprocessing earlier batches', async () => {
    const extraUsers = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        User.create({
          _id: new Types.ObjectId(),
          clerkId: `resume-user-${idx}`,
          email: `resume-${idx}@example.test`,
          username: `resume-user-${idx}`,
          displayName: `Resume User ${idx}`,
        })
      )
    );
    const allIds = [userId, ...extraUsers.map(u => u._id.toString())].sort();

    const store = new Map<string, string>();
    const redisClient: SweepRedisClient = {
      status: 'ready',
      get: vi.fn(async (key: string) => store.get(key) ?? null) as unknown as SweepRedisClient['get'],
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }) as unknown as SweepRedisClient['set'],
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)) as unknown as SweepRedisClient['del'],
    };

    const originalFind = User.find.bind(User);
    let findCalls = 0;
    const findSpy = vi.spyOn(User, 'find').mockImplementation(((...args: unknown[]) => {
      findCalls++;
      if (findCalls === 2) {
        return {
          sort: () => ({
            limit: () => ({
              select: () => ({
                lean: async () => {
                  throw new Error('transient Mongo cursor timeout');
                },
              }),
            }),
          }),
        } as never;
      }
      return originalFind(...(args as Parameters<typeof User.find>));
    }) as typeof User.find);

    const firstAttemptUsers: string[] = [];
    await expect(
      executeQuestGenerationSweep(now, {
        batchSize: 2,
        concurrency: 2,
        redisClient,
        processUser: async (uid, at) => {
          firstAttemptUsers.push(uid);
          return generateUserQuests(uid, at);
        },
      })
    ).rejects.toThrow('transient Mongo cursor timeout');

    findSpy.mockRestore();
    expect(firstAttemptUsers).toEqual(allIds.slice(0, 2));

    const expectedKey = `${QUEST_SWEEP_CHECKPOINT_PREFIX}:${questPeriods(now).daily.periodKey}`;
    expect(JSON.parse(store.get(expectedKey)!).lastUserId).toBe(allIds[1]);

    const resumedUsers: string[] = [];
    const resumedReport = await executeQuestGenerationSweep(now, {
      batchSize: 2,
      concurrency: 2,
      redisClient,
      processUser: async (uid, at) => {
        resumedUsers.push(uid);
        return generateUserQuests(uid, at);
      },
    });

    expect(resumedReport).toMatchObject({
      users: 4,
      failed: 0,
      batches: 2,
      resumedFromUserId: allIds[1],
      completed: true,
    });
    expect(resumedUsers).toEqual(allIds.slice(2));
    expect(store.has(expectedKey)).toBe(false);
    expect(await UserQuestProgress.countDocuments()).toBe(30);
  });

  it('isolates per-user failures so remaining users in the batch and later batches still succeed', async () => {
    const extraUsers = await Promise.all(
      Array.from({ length: 4 }, (_, idx) =>
        User.create({
          _id: new Types.ObjectId(),
          clerkId: `iso-user-${idx}`,
          email: `iso-${idx}@example.test`,
          username: `iso-user-${idx}`,
          displayName: `Iso User ${idx}`,
        })
      )
    );
    const failingUserId = extraUsers[1]._id.toString();

    // Real 503 pending-rollover failure for one user must not block the other 4 users.
    const sunday = new Date('2026-11-22T00:00:00Z');
    await LeagueStanding.create({
      userId: failingUserId,
      weekKey: '2026-11-15',
      division: 'silver',
      status: 'active',
      cohortId: '1',
      joinedAt: sunday,
    });

    const report = await executeQuestGenerationSweep(sunday, {
      batchSize: 3,
      concurrency: 3,
    });

    expect(report).toMatchObject({
      users: 4,
      failed: 1,
      batches: 2,
      completed: true,
    });
    expect(await UserQuestProgress.countDocuments({ userId: failingUserId })).toBe(0);
    expect(await UserQuestProgress.countDocuments()).toBe(20);
  });

  it('ignores corrupted or prior-period checkpoints and preserves checkpoint when lock is lost', async () => {
    const extraUser = await User.create({
      _id: new Types.ObjectId(),
      clerkId: 'lock-loss-user',
      email: 'lock-loss@example.test',
      username: 'lock-loss-user',
      displayName: 'Lock Loss User',
    });
    const allIds = [userId, extraUser._id.toString()].sort();
    const expectedKey = `${QUEST_SWEEP_CHECKPOINT_PREFIX}:${questPeriods(now).daily.periodKey}`;

    const store = new Map<string, string>([
      [expectedKey, JSON.stringify({ runId: 'old', periodKey: 'daily:2020-01-01', lastUserId: allIds[0] })],
    ]);
    const redisClient: SweepRedisClient = {
      status: 'ready',
      get: vi.fn(async (key: string) => store.get(key) ?? null) as unknown as SweepRedisClient['get'],
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }) as unknown as SweepRedisClient['set'],
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)) as unknown as SweepRedisClient['del'],
    };

    let batchesDone = 0;
    const interrupted = await executeQuestGenerationSweep(now, {
      batchSize: 1,
      concurrency: 1,
      redisClient,
      shouldContinue: () => batchesDone < 1,
      processUser: async (uid, at) => {
        batchesDone++;
        return generateUserQuests(uid, at);
      },
    });

    expect(interrupted).toMatchObject({
      users: 1,
      failed: 0,
      batches: 1,
      resumedFromUserId: null,
      completed: false,
    });
    expect(store.has(expectedKey)).toBe(true);
    expect(JSON.parse(store.get(expectedKey)!).lastUserId).toBe(allIds[0]);
  });
  it('registers UTC daily, Sunday weekly, and retryable startup catch-up jobs', async () => {
    const add = vi.fn().mockResolvedValue({});
    await scheduleQuestGeneration({ add } as never);
    expect(add).toHaveBeenCalledTimes(3);
    expect(add.mock.calls[0][2]).toMatchObject({ repeat: { pattern: '0 0 * * *', tz: 'UTC' }, attempts: 5 });
    expect(add.mock.calls[1][2]).toMatchObject({ repeat: { pattern: '0 0 * * 0', tz: 'UTC' } });
    expect(add.mock.calls[2][1]).toEqual({ task: 'generate_quests' });
  });
});

describe('durable event progress and completion', () => {
  it('increments daily and weekly counters from persisted solves, deduplicating event IDs and problem identities', async () => {
    const source = await solve();
    await trackQuestEvent(source.envelope, now);
    await trackQuestEvent(source.envelope, now);
    await trackQuestEvent({ ...source.envelope, id: randomUUID() }, now);
    const again = await DsaSubmission.create({ userId, problemId: source.problem._id, platform: 'leetcode', externalId: 'repeat', status: 'accepted', language: 'ts', submittedAt: now });
    await trackQuestEvent(event('dsa.submission.evaluated', { submissionId: again._id.toString() }), now);
    const rows = await UserQuestProgress.find({ kind: 'dsa_solve' }).lean();
    expect(rows.map(row => row.currentCount)).toEqual([1, 1]);
    expect(await ProcessedEvent.countDocuments({ consumer: 'quests.progress' })).toBe(2);
  });
  it('processes canonical solve events through the registered worker path', async () => {
    const source = await solve();
    registerQuestConsumers(); registerQuestConsumers();
    await processDomainReadinessJob(event('dsa.problem.solved', { problemId: source.problem._id.toString() }));
    expect((await UserQuestProgress.findOne({ slot: 'daily:dsa_solve' }))!.currentCount).toBe(1);
    expect(consumerRegistry.getQueues('dsa.problem.solved')).toEqual(['domain-readiness']);
  });
  it('supports canonical external problem identities backed by owned accepted submissions', async () => {
    const source = await solve();
    await trackQuestEvent(event('dsa.problem.solved', { platform: 'leetcode', problemId: source.problem.externalId }), now);
    expect((await UserQuestProgress.findOne({ slot: 'daily:dsa_solve' }))!.currentCount).toBe(1);
  });
  it('completes at the threshold once, caps progress, and stores an outbox notification', async () => {
    for (let index = 0; index < 3; index++) await trackQuestEvent((await solve()).envelope, now);
    const daily = await UserQuestProgress.findOne({ slot: 'daily:dsa_solve' });
    expect(daily).toMatchObject({ currentCount: 2, completed: true, claimed: false });
    expect(await OutboxEvent.countDocuments({ type: 'quest.completed' })).toBe(1);
    expect(await XpTransaction.countDocuments()).toBe(0);
  });
  it('rejects wrong-owner, unsuccessful, old-period, and future source evidence', async () => {
    const source = await solve();
    const other = new Types.ObjectId().toString();
    await User.create({ _id: other, clerkId: 'other', email: 'other@example.test', username: 'other-user', displayName: 'Other' });
    await trackQuestEvent({ ...source.envelope, userId: other }, now);
    await DsaSubmission.updateOne({ _id: source.submission._id }, { $set: { status: 'wrong' } });
    await trackQuestEvent(source.envelope, now);
    await trackQuestEvent((await solve(new Date(+now - 8 * 86_400_000))).envelope, now);
    await trackQuestEvent((await solve(new Date(+now + 86_400_000))).envelope, now);
    expect(await UserQuestProgress.countDocuments({ currentCount: { $gt: 0 } })).toBe(0);
  });
  it('credits quests when event occurred within validity period even if consumer processes after period expires (#581)', async () => {
    const quests = await generateUserQuests(userId, now);
    const activeQuest = quests.find(q => q.slot === 'daily:dsa_solve');
    expect(activeQuest).toBeDefined();
    const eventTime = new Date(+activeQuest!.expiresAt - 1000);
    const lateProcessingTime = new Date(+activeQuest!.expiresAt + 5000);
    const source = await solve(eventTime);
    await trackQuestEvent(source.envelope, lateProcessingTime);
    const updated = await UserQuestProgress.findById(activeQuest!._id);
    expect(updated!.currentCount).toBe(1);
  });
  it('does not credit a previously solved problem again in a later period', async () => {
    const source = await solve(new Date(+now - 8 * 86_400_000));
    const second = await DsaSubmission.create({ userId, problemId: source.problem._id, platform: 'leetcode', externalId: 'new-accept', status: 'accepted', language: 'ts', submittedAt: now });
    await trackQuestEvent(event('dsa.submission.evaluated', { submissionId: second._id.toString() }), now);
    expect(await UserQuestProgress.countDocuments({ currentCount: { $gt: 0 } })).toBe(0);
  });
  it('counts qualified focus minutes from the owned session and ignores payload duration or repeats', async () => {
    const session = await focus();
    const envelope = event('focus.session.completed', { sessionId: session._id.toString(), activeDurationMs: 999999999 });
    await trackQuestEvent(envelope, now); await trackQuestEvent({ ...envelope, id: randomUUID() }, now);
    expect((await UserQuestProgress.findOne({ slot: 'daily:focus_minutes' }))!.currentCount).toBe(30);
    expect((await UserQuestProgress.findOne({ slot: 'weekly:focus_minutes' }))!.currentCount).toBe(30);
  });
  it('ignores sessions with insufficient heartbeat coverage or duration', async () => {
    for (const session of [await focus(30, 1), await focus(10, 10)]) {
      await trackQuestEvent(event('focus.session.completed', { sessionId: session._id.toString() }), now);
    }
    expect(await UserQuestProgress.countDocuments({ currentCount: { $gt: 0 } })).toBe(0);
  });
  it('persists a review event with the actual producer and credits its owned sequence once', async () => {
    const card = await RevisionCard.create({ userId, problemKey: 'leetcode:review', title: 'Arrays', difficulty: 'medium', dueAt: now });
    await RevisionService.submitReview({ userId, cardId: card._id.toString(), rating: 'easy', reviewSeq: 0, now });
    const record = await OutboxEvent.findOne({ type: 'revision.reviewed' });
    expect(record).not.toBeNull();
    await trackQuestEvent(toEnvelope(record!), now);
    await trackQuestEvent({ ...toEnvelope(record!), type: 'revision.card_reviewed', id: randomUUID() }, now);
    expect((await UserQuestProgress.findOne({ slot: 'daily:revision_review' }))!.currentCount).toBe(1);
  });
  it('ignores a forged review without a committed source record', async () => {
    const card = await RevisionCard.create({ userId, problemKey: 'leetcode:forged', title: 'Arrays', difficulty: 'medium', dueAt: now, reviewSeq: 3 });
    await trackQuestEvent(event('revision.reviewed', { cardId: card._id.toString(), reviewSeq: 1, reviewedAt: now.toISOString() }), now);
    expect(await UserQuestProgress.countDocuments({ currentCount: { $gt: 0 } })).toBe(0);
  });
  it('rolls back progress, dedupe markers, and completion together on an outbox failure', async () => {
    await trackQuestEvent((await solve()).envelope, now);
    const second = await solve();
    vi.spyOn(OutboxEvent, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(trackQuestEvent(second.envelope, now)).rejects.toThrow('outbox unavailable');
    expect((await UserQuestProgress.findOne({ slot: 'daily:dsa_solve' }))!.currentCount).toBe(1);
    expect(await ProcessedEvent.countDocuments({ consumer: 'quests.progress' })).toBe(2);
    await trackQuestEvent(second.envelope, now);
    expect((await UserQuestProgress.findOne({ slot: 'daily:dsa_solve' }))!.completed).toBe(true);
    expect(await OutboxEvent.countDocuments({ type: 'quest.completed' })).toBe(1);
  });
  it('handles concurrent distinct events without lost increments or duplicate completion', async () => {
    const sources = await Promise.all([solve(), solve(), solve()]);
    await Promise.all(sources.map(source => trackQuestEvent(source.envelope, now)));
    expect((await UserQuestProgress.findOne({ slot: 'daily:dsa_solve' }))!.currentCount).toBe(2);
    expect((await UserQuestProgress.findOne({ slot: 'weekly:dsa_solve' }))!.currentCount).toBe(3);
    expect(await OutboxEvent.countDocuments({ type: 'quest.completed' })).toBe(1);
  });
  it('routes committed completion through the outbox relay and authenticated-user SSE consumer', async () => {
    for (let index = 0; index < 2; index++) await trackQuestEvent((await solve()).envelope, now);
    const enqueued: { queue: string; envelope: DomainEventEnvelope }[] = [];
    const relay = createDomainOutboxRelay(async (queue, _id, envelope) => { enqueued.push({ queue, envelope }); });
    await relay.tick();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].queue).toBe('domain-readiness');
    await processDomainReadinessJob(enqueued[0].envelope);
    expect(fixtures.publish).toHaveBeenCalledWith(userId, 'quest.completed', expect.objectContaining({ currentCount: 2 }), expect.any(String), 1);
  });
  it('retries notification delivery without changing progress', async () => {
    for (let index = 0; index < 2; index++) await trackQuestEvent((await solve()).envelope, now);
    const record = await OutboxEvent.findOne({ type: 'quest.completed' });
    fixtures.publish.mockRejectedValueOnce(new Error('SSE offline'));
    await expect(questNotificationConsumer.handle(toEnvelope(record!))).rejects.toThrow('SSE offline');
    await questNotificationConsumer.handle(toEnvelope(record!));
    expect((await UserQuestProgress.findOne({ slot: 'daily:dsa_solve' }))!.currentCount).toBe(2);
  });
  it('rejects unsupported versions and malformed identities', async () => {
    await expect(trackQuestEvent({ ...event('dsa.problem.solved', {}), schemaVersion: 2 }, now)).rejects.toThrow();
    await expect(trackQuestEvent(event('focus.session.completed', { sessionId: 'bad' }), now)).rejects.toThrow();
  });
});

describe('transactional XP and trophy claims', () => {
  it('credits XP, trophies, analytics, claim, ledger, and outbox together', async () => {
    const row = await eligible();
    const result = await processQuestReward(userId, row._id.toString(), now);
    expect(result).toMatchObject({ claimed: true, duplicate: false, totalXp: 20, leagueTrophies: 1 });
    expect((await UserXp.findOne({ userId }))!.lifetimeStats.totalXpEarned).toBe(20);
    expect((await UserAnalytics.findOne({ userId }))!.totalXp).toBe(20);
    expect(await XpTransaction.countDocuments({ sourceId: 'quest_' + row._id })).toBe(1);
    expect(await OutboxEvent.countDocuments({ type: 'quest.claimed' })).toBe(1);
  });
  it('prevents double credit across concurrent and repeated claims, even after expiry', async () => {
    const row = await eligible();
    const results = await Promise.all(Array.from({ length: 8 }, () => processQuestReward(userId, row._id.toString(), now)));
    expect(results.filter(result => !result.duplicate)).toHaveLength(1);
    expect(await XpTransaction.countDocuments()).toBe(1);
    expect((await UserXp.findOne({ userId }))!.totalXp).toBe(20);
    expect((await UserXp.findOne({ userId }))!.leagueTrophies).toBe(1);
    expect((await processQuestReward(userId, row._id.toString(), new Date(+now + 8 * 86_400_000))).duplicate).toBe(true);
  });
  it('rejects another user, incomplete quests, expired quests, and corrupt rewards', async () => {
    const row = (await generateUserQuests(userId, now))[0];
    await expect(processQuestReward(new Types.ObjectId().toString(), row._id.toString(), now)).rejects.toMatchObject({ statusCode: 404 });
    await expect(processQuestReward(userId, row._id.toString(), now)).rejects.toMatchObject({ statusCode: 409 });
    await UserQuestProgress.updateOne({ _id: row._id }, { $set: { completed: true, completedAt: now, currentCount: row.targetCount } });
    await expect(processQuestReward(userId, row._id.toString(), new Date(+row.expiresAt))).rejects.toMatchObject({ statusCode: 409 });
    await UserQuestProgress.updateOne({ _id: row._id }, { $set: { xpReward: 0.5 } });
    await expect(processQuestReward(userId, row._id.toString(), now)).rejects.toThrow('Invalid persisted quest reward');
    expect(await XpTransaction.countDocuments()).toBe(0);
  });
  it('rolls back the entire reward when the outbox write fails', async () => {
    const row = await eligible();
    vi.spyOn(OutboxEvent, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(processQuestReward(userId, row._id.toString(), now)).rejects.toThrow('outbox unavailable');
    expect((await UserXp.findOne({ userId }))!.totalXp).toBe(0);
    expect((await UserQuestProgress.findById(row._id))!.claimed).toBe(false);
    expect(await XpTransaction.countDocuments()).toBe(0);
    expect(await UserAnalytics.countDocuments()).toBe(0);
    expect((await processQuestReward(userId, row._id.toString(), now)).duplicate).toBe(false);
    expect((await UserXp.findOne({ userId }))!.totalXp).toBe(20);
    expect(await XpTransaction.countDocuments({ sourceId: 'quest_' + row._id })).toBe(1);
  });
  it('guards XP increment with atomic claimed:false transition and never double-credits on partial state', async () => {
    const row = await eligible();
    const xpSpy = vi.spyOn(UserXp, 'updateOne');
    // Simulate a race where claimed was already flipped to true before updateOne
    vi.spyOn(UserQuestProgress, 'findOneAndUpdate').mockResolvedValueOnce(null as any);
    const res = await processQuestReward(userId, row._id.toString(), now);
    expect(res.duplicate).toBe(true);
    expect(xpSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ $inc: expect.anything() }),
      expect.anything(),
    );
    expect((await UserXp.findOne({ userId }))!.totalXp).toBe(0);
  });
  it('retries post-commit league/SSE projections from durable reward identity without paying again', async () => {
    const row = await eligible();
    await processQuestReward(userId, row._id.toString(), now);
    const record = await OutboxEvent.findOne({ type: 'quest.claimed' });
    fixtures.league.mockRejectedValueOnce(new Error('queue offline'));
    await expect(questNotificationConsumer.handle(toEnvelope(record!))).rejects.toThrow('queue offline');
    await questNotificationConsumer.handle(toEnvelope(record!));
    expect(fixtures.league).toHaveBeenCalledWith(expect.objectContaining({ userId, sourceId: 'quest_' + row._id, xpAwarded: 20 }));
    expect(fixtures.publish).toHaveBeenCalledWith(userId, 'quest.claimed', expect.any(Object), expect.any(String), 1);
    expect(await XpTransaction.countDocuments()).toBe(1);
  });
});

describe('quest HTTP API', () => {
  let server: Server; let origin: string;
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    const router = express.Router(); router.use('/quests', questRoutes);
    mountApiRoutes(app, router); app.use(errorHandler);
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = (path: string, body?: unknown, token = 'fixture') => fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  it('lists the five owned instances over the v2 and compatibility mounts', async () => {
    for (const prefix of ['/api/v2', '/api/v1', '/api']) {
      const res = await request(prefix + '/quests');
      expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect((await res.json()).data.quests).toHaveLength(5);
    }
  });
  it('requires authentication and applies the established limiter', async () => {
    expect((await request('/api/v2/quests', undefined, 'bad')).status).toBe(401);
    fixtures.limited = true;
    expect((await request('/api/v2/quests')).status).toBe(429);
    expect(await UserQuestProgress.countDocuments()).toBe(0);
  });
  it('validates IDs and forbids caller-provided reward overrides', async () => {
    expect((await request('/api/v2/quests/bad/claim', {})).status).toBe(400);
    const row = await eligible();
    expect((await request('/api/v2/quests/' + row._id + '/claim', { xpReward: 99999 })).status).toBe(400);
    expect(await XpTransaction.countDocuments()).toBe(0);
  });
  it('claims the owned instance and returns idempotent retries', async () => {
    const row = await eligible();
    const first = await request('/api/v2/quests/' + row._id + '/claim', {});
    expect(first.status).toBe(200); expect((await first.json()).data.duplicate).toBe(false);
    const retry = await request('/api/v2/quests/' + row._id + '/claim', {});
    expect((await retry.json()).data.duplicate).toBe(true);
    expect((await request('/api/v2/quests/' + new Types.ObjectId() + '/claim', {})).status).toBe(404);
  });
});
