// tests/chaos/helpers/fakeBullmq.ts — A small in-process model of the BullMQ behaviour the
// worker-kill scenarios depend on: job locks, lock renewal, the two-phase stalled-job
// checker (maxStalledCount, "job stalled more than allowable limit"), retries and
// failed-event routing. It runs on vitest fake timers, so recovery times are exact.
//
// Fidelity notes (checked against bullmq 5.76.7, classes/worker.js and
// commands/moveStalledJobsToWait-8.lua):
//   * defaults: lockDuration 30000, stalledInterval 30000, maxStalledCount 1
//   * a worker renews its locks every lockDuration / 2
//   * the stalled checker runs on start and then every stalledInterval; a job is only moved
//     back to wait when it was already marked on the previous pass AND its lock is gone
//   * a job stalling more than maxStalledCount times gets a deferred failure; the next worker
//     to pick it up fails it with an UnrecoverableError instead of running it
//   * a result from a worker that lost its lock is discarded (BullMQ: "Missing lock for job")
// What is NOT modelled: Redis itself, rate limiting, flows, repeatable jobs.

import { EventEmitter } from 'node:events';

export const BULLMQ_DEFAULTS = { lockDuration: 30_000, stalledInterval: 30_000, maxStalledCount: 1, concurrency: 1 } as const;
export const STALLED_FAILURE = 'job stalled more than allowable limit';

type State = 'wait' | 'delayed' | 'active' | 'completed' | 'failed';

interface JobRecord {
  id: string;
  queue: string;
  name: string;
  data: any;
  opts: Record<string, any>;
  timestamp: number;
  state: State;
  attemptsMade: number;
  attemptsStarted: number;
  stalledCount: number;
  discarded: boolean;
  deferredFailure?: string;
  failedReason?: string;
  returnvalue?: unknown;
  lock?: { token: string; until: number };
}

export class FakeJob {
  constructor(private readonly broker: FakeBroker, readonly record: JobRecord) {}
  get id() { return this.record.id; }
  get name() { return this.record.name; }
  get data() { return this.record.data; }
  get opts() { return this.record.opts; }
  get timestamp() { return this.record.timestamp; }
  get attemptsMade() { return this.record.attemptsMade; }
  get attemptsStarted() { return this.record.attemptsStarted; }
  get stacktrace(): string[] { return []; }
  discard(): void { this.record.discarded = true; }
  async remove(): Promise<void> { this.broker.remove(this.record.queue, this.record.id); }
}

export class FakeBroker {
  private jobs = new Map<string, Map<string, JobRecord>>();
  private stalledMarks = new Map<string, Set<string>>();
  readonly workers: FakeWorker[] = [];
  private nextToken = 0;

  reset(): void {
    for (const worker of this.workers) worker.kill();
    this.workers.length = 0;
    this.jobs.clear();
    this.stalledMarks.clear();
  }

  token(): string { return `lock-${++this.nextToken}`; }

  queueJobs(queue: string): Map<string, JobRecord> {
    let map = this.jobs.get(queue);
    if (!map) { map = new Map(); this.jobs.set(queue, map); }
    return map;
  }

  add(queue: string, name: string, data: unknown, opts: Record<string, any>): FakeJob {
    const jobs = this.queueJobs(queue);
    const id = String(opts.jobId ?? `${queue}-${jobs.size + 1}`);
    const existing = jobs.get(id);
    if (existing) return new FakeJob(this, existing); // BullMQ ignores an add whose jobId already exists
    const record: JobRecord = {
      id, queue, name, data, opts, timestamp: Date.now(), state: 'wait',
      attemptsMade: 0, attemptsStarted: 0, stalledCount: 0, discarded: false,
    };
    jobs.set(id, record);
    this.wake(queue);
    return new FakeJob(this, record);
  }

  get(queue: string, id: string): JobRecord | undefined { return this.queueJobs(queue).get(id); }
  remove(queue: string, id: string): void { this.queueJobs(queue).delete(id); }
  inState(queue: string, state: State): JobRecord[] { return [...this.queueJobs(queue).values()].filter((j) => j.state === state); }
  wake(queue: string): void { for (const w of this.workers) if (w.queueName === queue) w.fill(); }

  marks(queue: string): Set<string> {
    let set = this.stalledMarks.get(queue);
    if (!set) { set = new Set(); this.stalledMarks.set(queue, set); }
    return set;
  }
}

export const broker = new FakeBroker();

// The real class is injected by the vi.mock('bullmq') factory (this file cannot import the
// mocked module itself), so `instanceof UnrecoverableError` checks in production code hold.
let UnrecoverableErrorClass: new (message: string) => Error = Error;
export function useUnrecoverableError(ctor: new (message: string) => Error): void {
  UnrecoverableErrorClass = ctor;
}

export interface FakeWorkerOptions {
  lockDuration?: number;
  stalledInterval?: number;
  maxStalledCount?: number;
  concurrency?: number;
  [key: string]: unknown;
}

export class FakeWorker extends EventEmitter {
  readonly opts: Required<Pick<FakeWorkerOptions, 'lockDuration' | 'stalledInterval' | 'maxStalledCount' | 'concurrency'>> & FakeWorkerOptions;
  killed = false;
  frozen = false;
  closing = false;
  private inflight = new Set<Promise<void>>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  /** Jobs this worker started (including ones whose result was later discarded). */
  readonly started: string[] = [];

  constructor(readonly queueName: string, readonly processor: (job: FakeJob) => Promise<unknown>, opts: FakeWorkerOptions = {}) {
    super();
    this.opts = { ...BULLMQ_DEFAULTS, ...opts };
    if (this.opts.stalledInterval <= 0) throw new Error('stalledInterval must be greater than 0');
    broker.workers.push(this);
    this.timers.push(setInterval(() => this.renewLocks(), this.opts.lockDuration / 2));
    this.timers.push(setInterval(() => this.checkStalled(), this.opts.stalledInterval));
    this.checkStalled();
    this.fill();
  }

  get busy(): boolean { return this.inflight.size > 0; }

  /** SIGKILL: no more timers, no lock release, results of in-flight work are dropped. */
  kill(): void {
    this.killed = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  /** Process stops being scheduled (GC pause, VM freeze) but is not dead: it resumes later. */
  freeze(): void { this.frozen = true; }
  thaw(): void { this.frozen = false; }

  async close(): Promise<void> {
    if (this.killed) return;
    this.closing = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    await Promise.all([...this.inflight]);
  }

  private alive(): boolean { return !this.killed && !this.closing && !this.frozen; }

  private renewLocks(): void {
    if (this.killed || this.frozen) return;
    for (const rec of broker.inState(this.queueName, 'active')) {
      if (rec.lock && this.holding.has(rec.id)) rec.lock.until = Date.now() + this.opts.lockDuration;
    }
  }

  private holding = new Set<string>();

  private checkStalled(): void {
    if (this.killed || this.frozen) return;
    const marks = broker.marks(this.queueName);
    for (const id of [...marks]) {
      const rec = broker.get(this.queueName, id);
      if (!rec || rec.state !== 'active' || (rec.lock && rec.lock.until > Date.now())) continue;
      rec.stalledCount++;
      if (rec.stalledCount > this.opts.maxStalledCount) rec.deferredFailure = STALLED_FAILURE;
      rec.state = 'wait';
      rec.lock = undefined;
      this.emit('stalled', id, 'active');
    }
    marks.clear();
    for (const rec of broker.inState(this.queueName, 'active')) marks.add(rec.id);
    broker.wake(this.queueName);
  }

  fill(): void {
    while (this.alive() && this.inflight.size < this.opts.concurrency) {
      const rec = broker.inState(this.queueName, 'wait')[0];
      if (!rec) return;
      const token = broker.token();
      rec.state = 'active';
      rec.attemptsStarted++;
      rec.lock = { token, until: Date.now() + this.opts.lockDuration };
      this.holding.add(rec.id);
      this.started.push(rec.id);
      const run = this.run(rec, token).finally(() => {
        this.holding.delete(rec.id);
        this.inflight.delete(run);
        this.fill();
      });
      this.inflight.add(run);
    }
  }

  private lockLost(rec: JobRecord, token: string): boolean {
    if (rec.lock?.token === token && rec.lock.until > Date.now()) return false;
    if (this.listenerCount('error') > 0) this.emit('error', new Error(`Missing lock for job ${rec.id}. moveToFinished`));
    return true;
  }

  private async run(rec: JobRecord, token: string): Promise<void> {
    const job = new FakeJob(broker, rec);
    let result: unknown;
    let failure: Error | undefined;
    if (rec.deferredFailure) {
      failure = new UnrecoverableErrorClass(rec.deferredFailure);
    } else {
      try { result = await this.processor(job); } catch (error) { failure = error as Error; }
    }
    if (this.killed || this.lockLost(rec, token)) return;

    rec.lock = undefined;
    if (!failure) {
      rec.state = 'completed';
      rec.returnvalue = result;
      this.emit('completed', job, result, 'active');
      return;
    }
    rec.attemptsMade++;
    rec.failedReason = failure.message;
    const unrecoverable = failure.name === 'UnrecoverableError';
    const attempts = rec.opts.attempts ?? 1;
    if (!unrecoverable && !rec.discarded && rec.attemptsMade < attempts) {
      rec.state = 'delayed';
      const delay = rec.opts.backoff?.delay ?? 0;
      setTimeout(() => { if (rec.state === 'delayed') { rec.state = 'wait'; broker.wake(this.queueName); } }, delay * 2 ** (rec.attemptsMade - 1));
    } else {
      rec.state = 'failed';
    }
    this.emit('failed', job, failure, 'active');
  }
}

export class FakeQueue {
  constructor(readonly name: string, readonly opts: { defaultJobOptions?: Record<string, any> } = {}) {}
  async add(name: string, data: unknown, opts: Record<string, any> = {}): Promise<FakeJob> {
    return broker.add(this.name, name, data, { ...this.opts.defaultJobOptions, ...opts });
  }
  async getJob(id: string): Promise<FakeJob | undefined> {
    const rec = broker.get(this.name, id);
    return rec ? new FakeJob(broker, rec) : undefined;
  }
  async getJobs(types: string[]): Promise<FakeJob[]> {
    return [...broker.queueJobs(this.name).values()]
      .filter((rec) => types.includes(rec.state === 'wait' ? 'wait' : rec.state))
      .map((rec) => new FakeJob(broker, rec));
  }
  async close(): Promise<void> {}
}
