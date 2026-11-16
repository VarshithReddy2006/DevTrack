// tests/chaos/workerKillMidSaga.test.ts — Chaos: a worker is killed in the middle of the XP saga.
//
// The saga is the real xp-processing pipeline on main: ledger credit (XpTransaction + UserXp in
// one Mongo transaction) -> UserAnalytics sync -> cache invalidation -> SSE publish -> runtime
// state sync. Real code under test: startXpWorker / createDlqWorker / attachWorkerDlq,
// processXpEvent (idempotency), dlqService replay and the real BullMQ worker options the code
// passes. Fake: the BullMQ broker (helpers/fakeBullmq.ts, on fake timers), Redis, and the
// cache / runtime-state / mission side services. MongoDB is a real in-memory replica set,
// because the double-credit guarantee lives in its transactions and unique index.
//
// "Kill" means the process vanishes at that line: nothing after it runs, its lock is not
// released, and BullMQ has to notice through stalled-job recovery.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { setTimeout as realSleep } from 'node:timers/promises';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FakeRedis } from './helpers/fakeRedis.js';
import { BULLMQ_DEFAULTS, STALLED_FAILURE, FakeWorker, broker } from './helpers/fakeBullmq.js';

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  const { FakeWorker: Worker, FakeQueue: Queue, useUnrecoverableError } = await import('./helpers/fakeBullmq.js');
  useUnrecoverableError(actual.UnrecoverableError);
  return { ...actual, Worker, Queue };
});
vi.mock('../../src/shared/redis/client.js', async () => {
  const { FakeRedis: Fake } = await import('./helpers/fakeRedis.js');
  const redis = new Fake();
  return { getRedisClient: () => redis, getRedisHealth: () => ({ status: 'connected' }), isRedisConfigured: () => false };
});
vi.mock('../../src/shared/redis/index.js', async () => {
  const client = await import('../../src/shared/redis/client.js');
  return { getRedisClient: client.getRedisClient, getRedisHealth: client.getRedisHealth, isRedisConfigured: client.isRedisConfigured };
});
vi.mock('../../src/shared/cache/cacheManager.js', () => ({ cacheManager: { invalidateAllUserCache: vi.fn(async () => undefined) } }));
vi.mock('../../src/modules/runtime-state/unifiedRuntimeState.service.js', () => ({
  unifiedRuntimeStateService: { updateFromEvent: vi.fn(async () => undefined) },
}));
vi.mock('../../src/modules/missions/missionProgress.service.js', () => ({ updateMissionProgress: vi.fn(async () => undefined) }));

import { UserAnalytics, UserXp, XpTransaction } from '../../src/db/models/index.js';
import { cacheManager } from '../../src/shared/cache/cacheManager.js';
import { dlqService } from '../../src/shared/jobs/dlq.service.js';
import { getXpProcessingQueue } from '../../src/shared/jobs/queueFactory.js';
import { QueueNames } from '../../src/shared/jobs/types.js';
import { startXpWorker, stopXpWorker } from '../../src/shared/jobs/xpWorker.js';
import { eventBus } from '../../src/shared/sse/eventBus.js';
import { unifiedRuntimeStateService } from '../../src/modules/runtime-state/unifiedRuntimeState.service.js';
import { XP_REWARDS } from '../../src/modules/xp/rules.js';

const QUEUE = QueueNames.XP_PROCESSING;
const DELTA_SOLVED = 3;
const AWARD = DELTA_SOLVED * XP_REWARDS.syncCompleted;

let replSet: MongoMemoryReplSet;
const hang = () => new Promise<never>(() => undefined); // the process is gone; this never returns

beforeAll(async () => {
  process.env.MONGOMS_MD5_CHECK = '0';
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: '7.0.14' } });
  await mongoose.connect(replSet.getUri());
  await Promise.all([UserXp.init(), XpTransaction.init(), UserAnalytics.init()]); // unique indexes exist before the first race
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

let userId: string;
let sourceId: string;
let jobId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: 1_700_000_000_000 });
  userId = new Types.ObjectId().toString();
  sourceId = `sync_${userId}_leetcode_30`;
  jobId = `xp-sync-leetcode-${sourceId}`;
  vi.mocked(cacheManager.invalidateAllUserCache).mockClear();
  vi.mocked(unifiedRuntimeStateService.updateFromEvent).mockClear();
});

afterEach(async () => {
  await stopXpWorker();
  broker.reset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const enqueue = () =>
  getXpProcessingQueue().add(
    'sync-completed-xp',
    { userId, sourceType: 'sync_completed', sourceId, metadata: { platform: 'leetcode', deltaSolved: DELTA_SOLVED } },
    { jobId },
  );

/** Start a worker through the production entrypoint. */
async function bootWorker(): Promise<FakeWorker> {
  await stopXpWorker(); // clears the module singleton, as a process restart would
  return startXpWorker() as unknown as FakeWorker;
}

/** Wait (real time) for work that depends on Mongo I/O, not on the BullMQ clock. */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  for (let waited = 0; !(await condition()); waited += 10) {
    if (waited >= timeoutMs) throw new Error(`condition not met within ${timeoutMs}ms of real time`);
    await realSleep(10);
  }
}

/**
 * Advance the fake BullMQ clock in 1s steps, yielding to real I/O after each step, until the
 * condition holds. Returns the fake milliseconds that passed.
 */
async function advanceUntil(condition: () => boolean | Promise<boolean>, budgetMs: number): Promise<number> {
  let elapsed = 0;
  while (!(await condition())) {
    if (elapsed >= budgetMs) throw new Error(`condition not met within ${budgetMs}ms of fake time`);
    await vi.advanceTimersByTimeAsync(1000);
    await realSleep(25);
    elapsed += 1000;
  }
  return elapsed;
}

const job = () => broker.get(QUEUE, jobId)!;
const ledgerRows = () => XpTransaction.countDocuments({ userId: new Types.ObjectId(userId), sourceType: 'sync_completed', sourceId });
const userXp = () => UserXp.findOne({ userId: new Types.ObjectId(userId) }).lean();
const analytics = () => UserAnalytics.findOne({ userId: new Types.ObjectId(userId) }).lean();

type CrashPoint = { name: string; committed: boolean; arm: (worker: FakeWorker) => void };
const kill = (worker: FakeWorker) => worker.kill();
const crashPoints: CrashPoint[] = [
  {
    name: 'inside the ledger transaction, before commit',
    committed: false,
    arm: (w) => void vi.spyOn(XpTransaction, 'create').mockImplementationOnce((async () => { kill(w); throw new Error('process killed'); }) as never),
  },
  {
    name: 'after the ledger commit, before the analytics sync',
    committed: true,
    arm: (w) => void vi.spyOn(UserAnalytics, 'findOne').mockImplementationOnce((() => { kill(w); return hang(); }) as never),
  },
  {
    name: 'after the analytics sync, before cache invalidation',
    committed: true,
    arm: (w) => void vi.mocked(cacheManager.invalidateAllUserCache).mockImplementationOnce(() => { kill(w); return hang(); }),
  },
  {
    name: 'after the SSE publish, before the runtime-state sync',
    committed: true,
    arm: (w) => void vi.mocked(unifiedRuntimeStateService.updateFromEvent).mockImplementationOnce(() => { kill(w); return hang(); }),
  },
];

describe('Chaos: worker killed mid XP saga', () => {
  describe('the worker configuration BullMQ recovers with', () => {
    it('keeps the BullMQ defaults the recovery math below relies on', () => {
      const source = readFileSync(new URL('../../node_modules/bullmq/dist/esm/classes/worker.js', import.meta.url), 'utf8');
      const declared = /lockDuration: (\d+).*?maxStalledCount: (\d+), stalledInterval: (\d+)/s.exec(source)!;
      expect(Number(declared[1])).toBe(BULLMQ_DEFAULTS.lockDuration);
      expect(Number(declared[2])).toBe(BULLMQ_DEFAULTS.maxStalledCount);
      expect(Number(declared[3])).toBe(BULLMQ_DEFAULTS.stalledInterval);
    });

    it('is started without overriding stalled-job settings, so a dead worker is detected within ~2 stall intervals', async () => {
      const worker = await bootWorker();
      expect(worker.queueName).toBe(QUEUE);
      expect(worker.opts.lockDuration).toBe(30_000);
      expect(worker.opts.stalledInterval).toBe(30_000);
      expect(worker.opts.maxStalledCount).toBe(1);
    });
  });

  describe.each(crashPoints)('killed $name', ({ committed, arm }) => {
    it('is recovered by a replacement worker with exactly one ledger credit and consistent aggregates', async () => {
      const first = await bootWorker();
      arm(first);
      await enqueue();
      await waitFor(() => first.killed);

      // The kill really landed mid-saga: nothing finished, the lock is still held by a dead process
      expect(job().state).toBe('active');
      expect(job().lock).toBeDefined();
      expect(await ledgerRows()).toBe(committed ? 1 : 0);
      expect((await userXp())?.totalXp ?? 0).toBe(committed ? AWARD : 0);

      const second = await bootWorker();
      const recoveryMs = await advanceUntil(() => job().state === 'completed', 2 * first.opts.stalledInterval + first.opts.lockDuration);

      expect(second.started).toEqual([jobId]);
      expect(job().stalledCount).toBe(1);
      expect(recoveryMs).toBeGreaterThanOrEqual(first.opts.lockDuration - 1000); // not stolen from a live lock
      expect(job().returnvalue).toMatchObject(committed ? { duplicate: true, awarded: false } : { duplicate: false, awarded: true, xpAwarded: AWARD });

      // No double credit, no lost credit
      expect(await ledgerRows()).toBe(1);
      expect((await userXp())?.totalXp).toBe(AWARD);
      expect((await userXp())?.lifetimeStats?.totalSyncs).toBe(1);
      // The aggregate the dashboard reads is repaired even when the first run died before writing it
      expect((await analytics())?.totalXp).toBe(AWARD);

      // Nothing stranded
      expect(broker.inState(QUEUE, 'active')).toEqual([]);
      expect(broker.inState(QUEUE, 'wait')).toEqual([]);
      expect(job().lock).toBeUndefined();
      expect(await dlqService.list(QUEUE)).toEqual([]);
    });
  });

  it('keeps a job whose worker is only paused: the late result is discarded and the credit is still single', async () => {
    const first = await bootWorker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Worker A commits the ledger, then freezes (GC pause / VM stall) before the analytics sync
    vi.spyOn(UserAnalytics, 'findOne').mockImplementationOnce((() => { first.freeze(); return gate.then(() => null); }) as never);
    await enqueue();
    await waitFor(() => first.frozen);
    expect(await ledgerRows()).toBe(1);

    // Worker B is a second process of the same service on the same queue
    const second = new FakeWorker(QUEUE, first.processor, first.opts);
    await advanceUntil(() => job().state === 'completed', 2 * first.opts.stalledInterval + first.opts.lockDuration);
    expect(second.started).toEqual([jobId]);
    const resultFromB = job().returnvalue;

    // Worker A wakes up and finishes its copy of the job
    first.thaw();
    first.on('error', () => undefined);
    release();
    await waitFor(() => !first.busy);

    expect(job().state).toBe('completed');
    expect(job().returnvalue).toBe(resultFromB);
    expect(await ledgerRows()).toBe(1);
    expect((await userXp())?.totalXp).toBe(AWARD);
    expect(job().lock).toBeUndefined();
  });

  it('quarantines a job that kills two workers in a row, loses no credit, and replays cleanly from the DLQ', async () => {
    const first = await bootWorker();
    crashPoints[0].arm(first);
    await enqueue();
    await waitFor(() => first.killed);

    const second = await bootWorker();
    crashPoints[0].arm(second);
    await advanceUntil(() => second.killed, 2 * first.opts.stalledInterval + first.opts.lockDuration);
    expect(job().stalledCount).toBe(1);

    const third = await bootWorker();
    await advanceUntil(() => job().state === 'failed', 2 * first.opts.stalledInterval + first.opts.lockDuration);

    // Stalled more often than maxStalledCount: failed, not retried forever, and not run a third time
    expect(job().failedReason).toBe(STALLED_FAILURE);
    expect(third.started).toEqual([jobId]);
    expect(await ledgerRows()).toBe(0);
    expect((await userXp())?.totalXp ?? 0).toBe(0);
    expect(broker.inState(QUEUE, 'active')).toEqual([]);

    // The failure is routed to the DLQ (not stranded in the failed set) and is replayable
    await waitFor(async () => (await dlqService.list(QUEUE)).length === 1);
    const [entry] = await dlqService.list(QUEUE);
    expect(entry).toMatchObject({ originalQueue: QUEUE, originalJobId: jobId, failureReason: STALLED_FAILURE, jobData: { userId, sourceId } });

    await dlqService.replayFromDlq(QUEUE, entry.id);
    expect(await dlqService.list(QUEUE)).toEqual([]);
    const replayId = `dlq-replay-${entry.id}`;
    await waitFor(() => broker.get(QUEUE, replayId)?.state === 'completed');

    expect(await ledgerRows()).toBe(1);
    expect((await userXp())?.totalXp).toBe(AWARD);

    // A second replay request for the same dead letter cannot mint a second credit
    await getXpProcessingQueue().add('sync-completed-xp', entry.jobData, { jobId: `dlq-replay-again` });
    await waitFor(() => broker.get(QUEUE, 'dlq-replay-again')?.state === 'completed');
    expect(await ledgerRows()).toBe(1);
    expect((await userXp())?.totalXp).toBe(AWARD);
  });

  // KNOWN GAP (reported in the PR): the post-commit side effects (cache invalidation and the
  // xp_updated / level_up SSE events) only run on the first execution. If the worker dies after
  // the ledger commit, the replacement takes the idempotent "duplicate" branch, repairs
  // UserAnalytics, and returns without invalidating the user's caches or telling the client.
  // `it.fails` keeps CI green while the gap exists; flip it to `it` once the duplicate branch
  // re-drives those effects.
  it.fails('re-drives cache invalidation and the SSE publish when the first run died after the commit', async () => {
    const emitted = vi.spyOn(eventBus, 'emitXpUpdated');
    const first = await bootWorker();
    crashPoints[2].arm(first); // dies inside cache invalidation: commit and analytics are done
    await enqueue();
    await waitFor(() => first.killed);
    vi.mocked(cacheManager.invalidateAllUserCache).mockClear();
    emitted.mockClear();

    await bootWorker();
    await advanceUntil(() => job().state === 'completed', 2 * first.opts.stalledInterval + first.opts.lockDuration);

    expect(cacheManager.invalidateAllUserCache).toHaveBeenCalledWith(userId);
    expect(emitted).toHaveBeenCalled();
  });
});
