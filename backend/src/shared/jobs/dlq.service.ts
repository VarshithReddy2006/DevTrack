import { createHash } from 'node:crypto';
import { Queue, Job, Worker, UnrecoverableError, type JobsOptions, type WorkerOptions } from 'bullmq';
import { getRedisClient } from '../redis/client.js';
import { logger } from '../logger.js';
import { QueueNames } from './types.js';
import { NonRetryableError } from '../../infrastructure/queues/ErrorClassifier.js';

export const DLQ_QUEUE_NAMES: readonly string[] = [...new Set([
  ...Object.values(QueueNames), 'ats-analysis', 'credibility-recalculation',
  'resume-generation', 'variant-generation', 'evidence-graph', 'embedding-generation', 'github-analysis',
])];

export type FailureCategory = 'transient' | 'validation' | 'dependency' | 'data_corruption' | 'quarantine' | 'timeout';
export interface DlqEntry {
  id: string;
  originalQueue: string;
  originalJobId: string;
  originalJobName?: string;
  originalOptions?: JobsOptions;
  jobData: Record<string, unknown>;
  failureReason: string;
  failureStack?: string;
  attemptCount: number;
  maxAttempts: number;
  failedAt: Date | string;
  categorizedAs: FailureCategory;
  recoverable: boolean;
  lastRetryAt?: Date | string;
  customMetadata?: Record<string, unknown>;
}

class DlqManager {
  readonly queue: Queue<DlqEntry>;
  constructor(private parentQueue: string) {
    // BullMQ rejects ':' in queue names. These entries wait for admin action;
    // there is intentionally no consumer for this queue.
    this.queue = new Queue<DlqEntry>(`${parentQueue}-dlq`, { connection: getRedisClient() });
  }

  async addFailedJob(job: Job, reason: string, attempts: number, maxAttempts: number, error?: Error): Promise<DlqEntry> {
    const category = categorizeFailure(reason, attempts, maxAttempts);
    const id = createHash('sha256').update(`${this.parentQueue}/${job.id}/${job.timestamp}/${attempts}`).digest('hex');
    const entry: DlqEntry = {
      id, originalQueue: this.parentQueue, originalJobId: job.id || 'unknown',
      originalJobName: job.name,
      originalOptions: {
        attempts: job.opts.attempts, backoff: job.opts.backoff, priority: job.opts.priority,
      },
      jobData: job.data, failureReason: reason,
      failureStack: error?.stack || job.stacktrace?.join('\n'),
      attemptCount: attempts, maxAttempts, failedAt: new Date(), categorizedAs: category,
      recoverable: ['transient', 'dependency', 'timeout'].includes(category),
      customMetadata: { timestamp: job.timestamp },
    };
    await this.queue.add('dead-letter', entry, { jobId: id });
    logger.warn('[dlq] Job quarantined', { queue: this.parentQueue, jobId: job.id, category });
    return entry;
  }

  async list(start = 0, end = 49): Promise<DlqEntry[]> {
    return (await this.queue.getJobs(['wait', 'paused'], start, end)).map(job => job.data);
  }

  async replayJob(id: string): Promise<void> {
    const job = await this.queue.getJob(id);
    if (!job) throw new DlqNotFoundError();
    const data = job.data;
    const { getOrCreateQueue } = await import('./queueFactory.js');
    // Deterministic replay IDs coalesce simultaneous admin requests. Preserve
    // the processor's job name and retry policy, never its old dedup/repeat ID.
    await getOrCreateQueue(this.parentQueue).add(data.originalJobName || 'replay', data.jobData, {
      ...data.originalOptions, jobId: `dlq-replay-${id}`,
    });
    try {
      const { DeadLetterJob } = await import('../../db/models/deadLetterJob.model.js');
      await DeadLetterJob.updateMany(
        { $or: [{ jobId: data.originalJobId }, { jobId: id }] },
        { $set: { recovered: true } }
      );
    } catch (dbErr) {
      logger.warn('[dlq] Failed to update DeadLetterJob audit status', { error: String(dbErr) });
    }
    await job.remove(); // Failed enqueue leaves the dead letter available.
  }

  async remove(id: string): Promise<void> {
    const job = await this.queue.getJob(id);
    if (!job) throw new DlqNotFoundError();
    await job.remove();
  }

  async getDlqMetrics() {
    const entries = await this.list(0, -1);
    const byCategory: Record<FailureCategory, number> = {
      transient: 0, validation: 0, dependency: 0, data_corruption: 0, quarantine: 0, timeout: 0,
    };
    let recoverable = 0;
    let oldestEntry: Date | null = null;
    for (const entry of entries) {
      byCategory[entry.categorizedAs]++;
      if (entry.recoverable) recoverable++;
      const failedAt = new Date(entry.failedAt);
      if (!oldestEntry || failedAt < oldestEntry) oldestEntry = failedAt;
    }
    return { total: entries.length, byCategory, recoverable, oldestEntry };
  }

  async close(): Promise<void> { await this.queue.close(); }
}

export class DlqNotFoundError extends Error {
  constructor() { super('DLQ job not found'); }
}

function categorizeFailure(reason: string, attempts: number, maxAttempts: number): FailureCategory {
  const text = reason.toLowerCase();
  if (/validation|invalid|schema/.test(text)) return 'validation';
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (/connection|econn|enosys|network|rate limit|429|503/.test(text)) return 'dependency';
  if (/corrupt|parse|cast/.test(text)) return 'data_corruption';
  return attempts >= maxAttempts ? 'quarantine' : 'transient';
}

const managers = new Map<string, DlqManager>();
export function getDlqManager(queueName: string): DlqManager {
  let manager = managers.get(queueName);
  if (!manager) {
    manager = new DlqManager(queueName);
    managers.set(queueName, manager);
  }
  return manager;
}

const attached = new WeakSet<Worker>();
export function attachWorkerDlq(worker: Worker, queueName: string): void {
  if (attached.has(worker)) return;
  attached.add(worker);
  const pending = new Set<Promise<unknown>>();
  worker.on('failed', (job, error) => {
    if (!job) return;
    // BullMQ increments attemptsMade before emitting failed; absent attempts
    // means one execution, regardless of queue defaults elsewhere.
    const maxAttempts = Math.max(1, job.opts.attempts || 1);
    if (!(error instanceof NonRetryableError) && !(error instanceof UnrecoverableError)
        && job.attemptsMade < maxAttempts) return;
    const capture = dlqService.quarantineJob(queueName, job, error.message, job.attemptsMade, maxAttempts, error)
      .catch(err => logger.error('[dlq] Capture failed; original job remains failed in its source queue', err))
      .finally(() => pending.delete(capture));
    pending.add(capture);
  });
  // EventEmitter does not await async listeners. Drain their writes before the
  // worker owner closes Redis during shutdown.
  const close = worker.close.bind(worker);
  worker.close = async (...args) => {
    await close(...args);
    await Promise.all([...pending]);
  };
}

/** Add terminal routing without changing an existing worker's retry classification. */
export function createDlqWorker<T = any>(
  queueName: string, processor: (job: Job<T>) => Promise<unknown>, options: WorkerOptions,
): Worker<T> {
  const worker = new Worker<T>(queueName, async job => {
    try { return await processor(job); }
    catch (error) {
      if (error instanceof NonRetryableError || error instanceof UnrecoverableError) job.discard();
      throw error;
    }
  }, options);
  attachWorkerDlq(worker, queueName);
  return worker;
}

export const dlqService = {
  async quarantineJob(queue: string, job: Job, reason: string, attempts: number, maxAttempts: number, error?: Error) {
    return getDlqManager(queue).addFailedJob(job, reason, attempts, maxAttempts, error);
  },
  async replayFromDlq(queue: string, id: string) { await getDlqManager(queue).replayJob(id); },
  async remove(queue: string, id: string) { await getDlqManager(queue).remove(id); },
  async list(queue: string, start = 0, end = 49) { return getDlqManager(queue).list(start, end); },
  async bulkReplay(queue: string, limit = 10) {
    const entries = await getDlqManager(queue).list(0, limit - 1);
    let succeeded = 0;
    let failed = 0;
    for (const entry of entries) {
      if (!entry.recoverable) continue;
      try { await getDlqManager(queue).replayJob(entry.id); succeeded++; }
      catch (err) { failed++; logger.warn('[dlq] Replay failed', { queue, id: entry.id, error: String(err) }); }
    }
    return { succeeded, failed };
  },
  async getAllDlqMetrics() {
    const metrics: Record<string, Awaited<ReturnType<DlqManager['getDlqMetrics']>>> = {};
    for (const queue of DLQ_QUEUE_NAMES) metrics[queue] = await getDlqManager(queue).getDlqMetrics();
    return metrics;
  },
  async cleanupDlq(queue: string, olderThanDays = 7) {
    const manager = getDlqManager(queue);
    const cutoff = Date.now() - olderThanDays * 86400000;
    let cleaned = 0;
    for (const entry of await manager.list(0, -1)) {
      if (new Date(entry.failedAt).getTime() < cutoff) { await manager.remove(entry.id); cleaned++; }
    }
    return cleaned;
  },
  async close() {
    await Promise.all([...managers.values()].map(manager => manager.close()));
    managers.clear();
  },
  async acquireLock(key: string, ttlMs = 10000) {
    return await getRedisClient().set(`lock:${key}`, '1', 'PX', ttlMs, 'NX') === 'OK';
  },
  async releaseLock(key: string) { await getRedisClient().del(`lock:${key}`); },
};
export default dlqService;
