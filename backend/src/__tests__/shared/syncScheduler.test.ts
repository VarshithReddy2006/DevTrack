// The queue is a fake that follows BullMQ's rules for custom ids and deduplication keys: no Redis.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type BulkJob = {
  name: string;
  data: { userId: string; platformName: string; requestId?: string };
  opts: {
    jobId: string;
    deduplication: { id: string };
    attempts: number;
    backoff: { type: string; delay: number; jitter: number };
  };
};

const fx = vi.hoisted(() => ({
  platforms: [] as { userId: string; platformName: string }[],
  jobs: new Map<string, unknown>(),
  dedup: new Map<string, string>(),
  batches: [] as unknown[][],
  add: vi.fn(),
  info: vi.fn(),
  completeSync: vi.fn(),
  release: vi.fn(async () => undefined),
  failBulk: false,
}));

vi.mock('../../db/models/index.js', () => ({
  ConnectedPlatform: { find: () => ({ lean: async () => fx.platforms }) },
}));
vi.mock('../../shared/jobs/index.js', () => ({
  getPlatformSyncQueue: () => ({
    add: fx.add,
    addBulk: async (batch: BulkJob[]) => {
      if (fx.failBulk) throw new Error('redis down');
      fx.batches.push(batch);
      return batch.map((job) => {
        const held = fx.dedup.get(job.opts.deduplication.id);
        if (held) return { id: held };
        if (!fx.jobs.has(job.opts.jobId)) {
          fx.jobs.set(job.opts.jobId, job);
          fx.dedup.set(job.opts.deduplication.id, job.opts.jobId);
        }
        return { id: job.opts.jobId };
      });
    },
  }),
}));
vi.mock('../../shared/syncState.js', () => ({
  syncState: { beginSync: vi.fn(), completeSync: fx.completeSync },
}));
vi.mock('../../shared/logger.js', () => ({
  logger: { info: fx.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config/env.js', () => ({ env: { SYNC_INTERVAL_MINUTES: 15, NODE_ENV: 'test' } }));
vi.mock('../../shared/redis/syncLock.service.js', () => ({
  acquireSchedulerLock: vi.fn(async () => true),
  releaseSchedulerLock: fx.release,
}));

import { runScheduledSync, SYNC_BULK_CHUNK_SIZE } from '../../shared/syncScheduler.js';

const connect = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ userId: `user${i}`, platformName: 'leetcode' }));
const submitted = () => fx.batches.flat() as BulkJob[];
const summary = () =>
  fx.info.mock.calls.filter(([message]) => message === '[sync-scheduler] Scheduled sync complete').at(-1)?.[1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:00:05.000Z'));
  vi.clearAllMocks();
  fx.jobs.clear();
  fx.dedup.clear();
  fx.batches.length = 0;
  fx.failBulk = false;
  fx.platforms = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runScheduledSync bulk enqueue', () => {
  it('sends 1,200 jobs in chunks and never calls queue.add', async () => {
    fx.platforms = connect(1200);
    await runScheduledSync();
    expect(fx.batches.map((b) => b.length)).toEqual([SYNC_BULK_CHUNK_SIZE, SYNC_BULK_CHUNK_SIZE, 200]);
    expect(fx.add).not.toHaveBeenCalled();
    expect(fx.jobs.size).toBe(1200);
    expect(summary()).toMatchObject({ jobsSubmitted: 1200, jobsHeldByEarlierJob: 0 });
  });

  it('builds deterministic ids without colons, with jittered retries', async () => {
    fx.platforms = connect(1);
    await runScheduledSync();
    const [job] = submitted();
    const window = Math.floor(Date.now() / (15 * 60_000));
    expect(job.opts.jobId).toBe(`sync-leetcode-user0-${window}`);
    expect(job.opts.jobId).not.toContain(':');
    expect(job.opts.deduplication).toEqual({ id: 'sync-leetcode-user0' });
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 2000, jitter: 0.5 });
    expect(job.data).toMatchObject({ userId: 'user0', platformName: 'leetcode' });
  });

  it('collapses duplicate connection rows', async () => {
    fx.platforms = [...connect(1), ...connect(1), { userId: 'user0', platformName: 'github' }];
    await runScheduledSync();
    expect(submitted().map((j) => j.data.platformName)).toEqual(['leetcode', 'github']);
  });

  it('does not grow the queue when swept again in the same window', async () => {
    fx.platforms = connect(3);
    await runScheduledSync();
    vi.advanceTimersByTime(60_000);
    await runScheduledSync();
    expect(fx.jobs.size).toBe(3);
  });

  it('holds back the next window while the earlier job is unfinished', async () => {
    fx.platforms = connect(3);
    await runScheduledSync();
    vi.advanceTimersByTime(15 * 60_000);
    await runScheduledSync();
    expect(fx.jobs.size).toBe(3);
    expect(summary()).toMatchObject({ jobsSubmitted: 3, jobsHeldByEarlierJob: 3 });
  });

  it('enqueues again in the next window once the earlier job has finished', async () => {
    fx.platforms = connect(3);
    await runScheduledSync();
    fx.dedup.clear(); // BullMQ drops the key when a job completes or fails
    vi.advanceTimersByTime(15 * 60_000);
    await runScheduledSync();
    expect(fx.jobs.size).toBe(6);
  });

  it('does not touch the queue when nothing is connected', async () => {
    await runScheduledSync();
    expect(fx.batches).toEqual([]);
    expect(fx.release).toHaveBeenCalled();
  });

  it('records a failed sweep and releases the lock when addBulk throws', async () => {
    fx.platforms = connect(2);
    fx.failBulk = true;
    await runScheduledSync();
    expect(fx.completeSync).toHaveBeenCalledWith('failed', expect.any(Number));
    expect(fx.release).toHaveBeenCalled();
  });
});
