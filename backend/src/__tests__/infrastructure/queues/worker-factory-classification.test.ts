import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same stubbing approach as __tests__/dlq/dlq.test.ts: capture the processor
// WorkerFactory hands to BullMQ and drive it by hand, no Redis involved.
const state = vi.hoisted(() => ({ processor: undefined as undefined | ((job: any) => Promise<unknown>), permanent: vi.fn() }));
vi.mock('bullmq', () => ({
  Worker: class {
    constructor(_queue: string, processor: (job: any) => Promise<unknown>) { state.processor = processor; }
    on() {}
  },
  UnrecoverableError: class extends Error {},
  Queue: class {},
}));
vi.mock('../../../shared/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../../shared/redis/index.js', () => ({ getRedisClient: () => ({}) }));
vi.mock('../../../shared/tracing/queueTelemetry.js', () => ({ getQueueTelemetry: () => undefined }));
vi.mock('../../../shared/jobs/dlq.service.js', () => ({ attachWorkerDlq: () => {} }));
vi.mock('../../../infrastructure/queues/DeadLetterHandler.js', () => ({
  DeadLetterHandler: { handlePermanentFailure: (...args: unknown[]) => state.permanent(...args) },
}));

import { WorkerFactory } from '../../../infrastructure/queues/WorkerFactory.js';
import { NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';

function makeJob(attemptsMade: number, attempts = 4) {
  return { id: 'job-1', attemptsMade, opts: { attempts }, data: {}, discard: vi.fn() };
}

async function run(processor: () => Promise<unknown>, job: ReturnType<typeof makeJob>, options?: Parameters<typeof WorkerFactory.createWorker>[2]) {
  WorkerFactory.createWorker('test-queue', processor, options);
  try {
    await state.processor!(job);
  } catch (error) {
    return error as Error;
  }
  throw new Error('processor was expected to throw');
}

describe('WorkerFactory with transient errors', () => {
  beforeEach(() => state.permanent.mockReset().mockResolvedValue(undefined));

  it.each([
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:6379',
    'getaddrinfo EAI_AGAIN api.openai.com',
    'socket hang up',
    'Server selection timed out after 30000 ms',
  ])('does not discard or dead-letter "%s" on attempt 1 of 4', async (message) => {
    const job = makeJob(0);
    const error = await run(async () => { throw new Error(message); }, job);
    expect(error).toBeInstanceOf(RetryableError);
    expect(job.discard).not.toHaveBeenCalled();
    expect(state.permanent).not.toHaveBeenCalled();
  });

  it('dead-letters a transient error once the last attempt is used, without discard', async () => {
    const job = makeJob(3);
    const error = await run(async () => { throw new Error('fetch failed'); }, job);
    expect(error).toBeInstanceOf(RetryableError);
    expect(state.permanent).toHaveBeenCalledTimes(1);
    expect(job.discard).not.toHaveBeenCalled();
  });

  it('still discards and dead-letters an unknown error on the first attempt', async () => {
    const job = makeJob(0);
    const error = await run(async () => { throw new Error('Unexpected token < in JSON'); }, job);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(job.discard).toHaveBeenCalledTimes(1);
    expect(state.permanent).toHaveBeenCalledTimes(1);
  });

  it('turns its own execution timeout into a retryable error', async () => {
    const job = makeJob(0);
    const error = await run(() => new Promise(() => {}), job, { jobTimeoutMs: 10 });
    expect(error).toBeInstanceOf(RetryableError);
    expect(error.message).toMatch(/timed out/);
    expect(job.discard).not.toHaveBeenCalled();
    expect(state.permanent).not.toHaveBeenCalled();
  });
});
