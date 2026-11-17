import { afterEach, describe, expect, it, vi } from 'vitest';
import { NonRetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { setJobTargetPort } from '../../../modules/job-targets/jobTarget.port.js';
import { InMemoryJobTargetPort, target } from './helpers.js';

const mocks = vi.hoisted(() => ({
  created: [] as Array<{ queue: string; run: (job: { data: unknown }) => Promise<unknown>; options: { concurrency?: number } }>,
  close: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../infrastructure/queues/WorkerFactory.js', () => ({
  WorkerFactory: {
    createWorker: (queue: string, run: (job: { data: unknown }) => Promise<unknown>, options: { concurrency?: number }) => {
      mocks.created.push({ queue, run, options });
      return { close: mocks.close };
    },
  },
}));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ add: mocks.add }) }));
// The gateway adapter is not under test here and must not reach a provider.
vi.mock('../../../modules/job-targets/jdLlm.js', () => ({
  createGatewayJdLlm: () => ({ isConfigured: () => false, complete: async () => { throw new Error('unreachable'); } }),
}));

const { startJdParseWorker, stopJdParseWorker, enqueueJdParse } = await import('../../../modules/job-targets/workers/jdParse.worker.js');
const { startJdScoreWorker, stopJdScoreWorker, enqueueJdScore, AI_WORKER_CONCURRENCY } = await import('../../../modules/job-targets/workers/jdScore.worker.js');

afterEach(async () => {
  await stopJdParseWorker();
  await stopJdScoreWorker();
  setJobTargetPort(null);
  mocks.created.length = 0;
  vi.clearAllMocks();
});

describe('ai pool workers', () => {
  it('starts jd-parse and jd-score through WorkerFactory with concurrency 4', () => {
    startJdParseWorker();
    startJdScoreWorker();
    expect(mocks.created.map(entry => entry.queue)).toEqual([QueueNames.JD_PARSE, QueueNames.JD_SCORE]);
    expect(QueueNames.JD_PARSE).toBe('jd-parse');
    expect(QueueNames.JD_SCORE).toBe('jd-score');
    expect(AI_WORKER_CONCURRENCY).toBe(4);
    for (const entry of mocks.created) expect(entry.options.concurrency).toBe(4);
  });

  it('is idempotent to start and drains on stop', async () => {
    startJdParseWorker();
    startJdParseWorker();
    startJdScoreWorker();
    startJdScoreWorker();
    expect(mocks.created).toHaveLength(2);
    await stopJdParseWorker();
    await stopJdScoreWorker();
    await stopJdParseWorker();
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });

  it('can start again after a stop', async () => {
    startJdScoreWorker();
    await stopJdScoreWorker();
    startJdScoreWorker();
    expect(mocks.created).toHaveLength(2);
  });

  it('runs a job end to end through the registered port and queues jd-score', async () => {
    const port = new InMemoryJobTargetPort();
    port.targets.set('jt1', target());
    setJobTargetPort(port);
    startJdParseWorker();
    const result = await mocks.created[0].run({ data: { userId: 'u1', jobTargetId: 'jt1' } });
    expect(result).toMatchObject({ analysisMode: 'taxonomy_only' });
    expect(port.targets.get('jt1')!.parse).toBeDefined();
    expect(mocks.add).toHaveBeenCalledOnce();
    const [name, data, options] = mocks.add.mock.calls[0];
    expect(name).toBe('jd-score');
    expect(data).toMatchObject({ userId: 'u1', jobTargetId: 'jt1' });
    expect(options.jobId).toMatch(/^jd-score-jt1-\d+$/);
  });

  it('refuses to run against storage that is not wired yet, as a non retryable failure', async () => {
    startJdParseWorker();
    await expect(mocks.created[0].run({ data: { userId: 'u1', jobTargetId: 'jt1' } })).rejects.toBeInstanceOf(NonRetryableError);
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it('enqueue helpers target the right queues', async () => {
    await enqueueJdParse({ userId: 'u1', jobTargetId: 'jt1' });
    await enqueueJdScore({ userId: 'u1', jobTargetId: 'jt1' }, '2026-11-17T10:00:00.000Z');
    expect(mocks.add.mock.calls.map(call => call[0])).toEqual(['jd-parse', 'jd-score']);
  });
});
