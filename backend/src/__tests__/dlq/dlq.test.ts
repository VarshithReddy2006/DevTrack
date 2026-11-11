import { EventEmitter } from 'node:events';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Job, Worker } from 'bullmq';

const state = vi.hoisted(() => ({ queues: new Map<string, any>(), failAdd: false, audit: vi.fn() }));
vi.mock('../../shared/redis/client.js', () => ({ getRedisClient: () => ({}) }));
vi.mock('../../shared/redis/index.js', () => ({ getRedisClient: () => ({}) }));
vi.mock('../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, res: any, next: any) => req.headers.authorization ? next() : res.sendStatus(401),
  adminMiddleware: (req: any, res: any, next: any) => req.headers.authorization === 'admin' ? next() : res.sendStatus(403),
}));
vi.mock('../../infrastructure/queues/DeadLetterHandler.js', () => ({ DeadLetterHandler: { handlePermanentFailure: state.audit } }));
vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  class Queue {
    jobs = new Map<string, any>();
    constructor(public name: string) {
      if (name.includes(':')) throw new Error('Queue name cannot contain :');
      state.queues.set(name, this);
    }
    async add(name: string, data: any, opts: any = {}) {
      if (state.failAdd) throw new Error('Redis unavailable');
      const id = opts.jobId || String(this.jobs.size + 1);
      if (!this.jobs.has(id)) this.jobs.set(id, {
        id, name, data: JSON.parse(JSON.stringify(data)), opts,
        remove: async () => { this.jobs.delete(id); },
      });
      return this.jobs.get(id);
    }
    async getJob(id: string) { return this.jobs.get(id); }
    async getJobs(states: string[], start: number, end: number) {
      expect(states).toEqual(['wait', 'paused']);
      return [...this.jobs.values()].slice(start, end === -1 ? undefined : end + 1);
    }
    async close() {}
  }
  class Worker extends EventEmitter {
    constructor(public name: string, public processor: any, public opts: any) { super(); }
    async close() {}
  }
  class UnrecoverableError extends Error {}
  return { Queue, Worker, UnrecoverableError };
});

import { attachWorkerDlq, createDlqWorker, dlqService, getDlqManager } from '../../shared/jobs/dlq.service.js';
import { NonRetryableError } from '../../infrastructure/queues/ErrorClassifier.js';
import { WorkerFactory } from '../../infrastructure/queues/WorkerFactory.js';
import { QueueRegistry } from '../../infrastructure/queues/QueueRegistry.js';
import { createDlqRoutes } from '../../routes/dlq.routes.js';

const queue = 'xp-processing';
function job(attemptsMade = 3, attempts: number | undefined = 3): Job {
  return { id: 'original', name: 'award-xp', timestamp: 123, data: { userId: 'u1', sourceId: 's1' },
    opts: { attempts, backoff: { type: 'exponential', delay: 5000 }, priority: 2 }, attemptsMade,
    discard: vi.fn(), stacktrace: ['original stack'] } as unknown as Job;
}
function worker() { return Object.assign(new EventEmitter(), { close: vi.fn(async () => {}) }) as unknown as Worker; }
async function capture(source = job(), error = new Error('network failed')) {
  const w = worker(); attachWorkerDlq(w, queue); w.emit('failed', source, error, 'active'); await w.close();
  return (await dlqService.list(queue))[0];
}

afterEach(async () => {
  state.failAdd = false; state.audit.mockClear();
  await dlqService.close(); await QueueRegistry.closeAllQueues(); state.queues.clear();
});

describe('terminal failure capture and replay', () => {
  it('captures exhausted retries with stack, payload, counts and processor identity', async () => {
    const error = new Error('network failed');
    const entry = await capture(job(), error);
    expect(entry).toMatchObject({ originalJobName: 'award-xp', originalQueue: queue, attemptCount: 3,
      maxAttempts: 3, failureStack: error.stack, categorizedAs: 'dependency', jobData: { userId: 'u1' } });
    expect((await getDlqManager(queue).getDlqMetrics()).total).toBe(1);
  });
  it('does not capture intermediate retries or a missing job', async () => {
    const w = worker(); attachWorkerDlq(w, queue);
    w.emit('failed', job(1, 3), new Error('network'), 'active'); w.emit('failed', undefined, new Error('network'), 'active');
    await w.close(); expect(await dlqService.list(queue)).toEqual([]);
  });
  it('uses one execution when the job has no attempts option', async () => {
    const source = job(1); delete source.opts.attempts;
    expect(await capture(source)).toMatchObject({ attemptCount: 1, maxAttempts: 1 });
  });
  it('captures non-retryable and BullMQ unrecoverable errors on the first failure', async () => {
    const { UnrecoverableError } = await import('bullmq');
    expect(await capture(job(1, 9), new NonRetryableError('invalid user'))).toMatchObject({ attemptCount: 1 });
    expect(await capture({ ...job(1, 9), id: 'other' } as Job, new UnrecoverableError('invalid payload'))).toBeDefined();
    expect(await dlqService.list(queue)).toHaveLength(2);
  });
  it('attaches once and deduplicates repeated terminal events', async () => {
    const w = worker(); attachWorkerDlq(w, queue); attachWorkerDlq(w, queue);
    expect(w.listenerCount('failed')).toBe(1);
    w.emit('failed', job(), new Error('network'), 'active'); w.emit('failed', job(), new Error('network'), 'active');
    await w.close(); expect(await dlqService.list(queue)).toHaveLength(1);
  });
  it('contains capture errors and drains pending writes on close', async () => {
    state.failAdd = true;
    const w = worker(); attachWorkerDlq(w, queue); w.emit('failed', job(), new Error('network'), 'active');
    await expect(w.close()).resolves.toBeUndefined();
    expect(await dlqService.list(queue)).toEqual([]);
  });
  it('replays the original name and options once across concurrent requests', async () => {
    const entry = await capture();
    await Promise.all([dlqService.replayFromDlq(queue, entry.id), dlqService.replayFromDlq(queue, entry.id)]);
    const jobs = [...state.queues.get(queue).jobs.values()] as any[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'award-xp', data: job().data, opts: { attempts: 3, priority: 2 } });
    expect(await dlqService.list(queue)).toEqual([]);
  });
  it('keeps the dead letter when enqueue fails and cleans serialized old dates', async () => {
    const entry = await capture(); state.failAdd = true;
    await expect(dlqService.replayFromDlq(queue, entry.id)).rejects.toThrow('Redis unavailable');
    state.failAdd = false;
    const stored = state.queues.get(`${queue}-dlq`).jobs.get(entry.id);
    stored.data.failedAt = new Date(Date.now() - 9 * 86400000).toISOString();
    expect(await dlqService.cleanupDlq(queue)).toBe(1);
  });
  it('raw workers discard explicit fatal errors and preserve ordinary retryable errors', async () => {
    const fatal = new NonRetryableError('invalid payload');
    const source = job(0, 5);
    const w = createDlqWorker(queue, async () => { throw fatal; }, { connection: {} });
    await expect((w as any).processor(source)).rejects.toBe(fatal);
    expect(source.discard).toHaveBeenCalledOnce();
    const transient = new Error('network');
    const other = job(0, 5);
    const retrying = createDlqWorker(queue, async () => { throw transient; }, { connection: {} });
    await expect((retrying as any).processor(other)).rejects.toBe(transient);
    expect(other.discard).not.toHaveBeenCalled();
    await w.close(); await retrying.close();
  });
  it('factory discards fatal jobs, captures them, and clears execution timers', async () => {
    const w = WorkerFactory.createWorker(queue, async () => { throw new NonRetryableError('invalid user'); });
    const source = job(0, 4);
    let error: Error | undefined;
    try { await (w as any).processor(source); } catch (err) { error = err as Error; }
    expect(source.discard).toHaveBeenCalledOnce(); expect(state.audit).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(Error);
    source.attemptsMade = 1; w.emit('failed', source, error as Error, 'active'); await w.close();
    expect(await dlqService.list(queue)).toHaveLength(1);
  });
});

describe('admin HTTP routes using captured dead letters', () => {
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let base: string;
  beforeAll(async () => {
    const app = express(); app.use('/api/system/dlq', createDlqRoutes());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/system/dlq`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  it('rejects unauthenticated and non-admin requests on every endpoint', async () => {
    for (const [path, method] of [['', 'GET'], ['/x/retry', 'POST'], ['/x', 'DELETE']]) {
      expect((await fetch(`${base}${path}?queue=${queue}`, { method })).status).toBe(401);
      expect((await fetch(`${base}${path}?queue=${queue}`, { method, headers: { authorization: 'user' } })).status).toBe(403);
    }
  });
  it('validates queue and pagination before accessing Redis', async () => {
    for (const query of ['queue=unknown', `queue=${queue}&limit=101`, `queue=${queue}&offset=-1`, '']) {
      expect((await fetch(`${base}?${query}`, { headers: { authorization: 'admin' } })).status).toBe(400);
    }
  });
  it('lists stack traces, replays, purges and returns 404 for absent records', async () => {
    const entry = await capture(); const headers = { authorization: 'admin' };
    const response = await fetch(`${base}?queue=${queue}`, { headers });
    expect((await response.json() as any).entries[0].failureStack).toContain('network failed');
    expect((await fetch(`${base}/${entry.id}/retry?queue=${queue}`, { method: 'POST', headers })).status).toBe(200);
    expect((await fetch(`${base}/${entry.id}/retry?queue=${queue}`, { method: 'POST', headers })).status).toBe(404);
    const next = await capture({ ...job(), id: 'next' } as Job);
    expect((await fetch(`${base}/${next.id}?queue=${queue}`, { method: 'DELETE', headers })).status).toBe(200);
    expect(await dlqService.list(queue)).toEqual([]);
  });
});
