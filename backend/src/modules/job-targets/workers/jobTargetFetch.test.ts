import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NonRetryableError, RetryableError } from '../../../infrastructure/queues/ErrorClassifier.js';
import { SafeFetchError } from '../safeFetch.js';
import { clearConsumerRegistry, getQueuesForEvent } from '../../../shared/events/consumerRegistry.js';
import { registerJobTargetSubmittedConsumer } from '../jobTargetSubmitted.consumer.js';
import { QueueNames } from '../../../shared/jobs/types.js';

const mocks = vi.hoisted(() => ({
  eval: vi.fn(), status: 'ready', createWorker: vi.fn(), close: vi.fn().mockResolvedValue(undefined),
  findOne: vi.fn(), updateOne: vi.fn(), add: vi.fn(),
}));
vi.mock('../../../shared/redis/index.js', () => ({ getRedisClient: () => mocks }));
vi.mock('../../../db/models/jobTarget.model.js', () => ({ JobTarget: { findOne: mocks.findOne, updateOne: mocks.updateOne } }));
vi.mock('../../../infrastructure/queues/WorkerFactory.js', () => ({ WorkerFactory: { createWorker: mocks.createWorker } }));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ add: mocks.add }) }));

const { processJobTargetFetch, reserveScrape, staticJobText, SCRAPE_LIMIT_SCRIPT, startJobTargetFetchWorker, stopJobTargetFetchWorker } = await import('./jobTargetFetch.worker.js');
import type { JobTargetFetchDeps } from './jobTargetFetch.worker.js';

const userId = '111111111111111111111111';
const jobTargetId = '222222222222222222222222';
const event = { type: 'jobtarget.submitted', schemaVersion: 1, userId, payload: { jobTargetId }, correlationId: 'request-1' };
const text = Array.from({ length: 160 }, (_, index) => 'requirement' + index).join(' ');
const response = (body = '<main>' + text + '</main>') => ({ url: 'https://jobs.example/', status: 200, headers: {}, body: Buffer.from(body) });
function fixture() {
  const stored = { text: null as string | null, url: 'https://jobs.example/' as string | null, status: 'submitted' };
  const deps = {
    load: vi.fn(async () => stored), fetching: vi.fn(async () => {}),
    save: vi.fn(async (_user: string, _id: string, value: string) => { stored.text = value; stored.status = 'ready'; return true; }),
    failed: vi.fn(async () => {}), fetch: vi.fn<JobTargetFetchDeps['fetch']>(async () => response()), scrape: vi.fn(async () => text),
    reserve: vi.fn(async () => {}), enqueue: vi.fn(async () => {}),
  } satisfies JobTargetFetchDeps;
  return { stored, deps };
}
beforeEach(() => { vi.clearAllMocks(); mocks.status = 'ready'; mocks.eval.mockResolvedValue(1); });
afterEach(async () => { await stopJobTargetFetchWorker(); clearConsumerRegistry(); });

describe('submitted job fetch pipeline', () => {
  it('uses static text when sufficient and then queues parsing', async () => {
    const { deps, stored } = fixture();
    await processJobTargetFetch(event, deps);
    expect(stored.text).toBe(text);
    expect(deps.scrape).not.toHaveBeenCalled();
    expect(deps.reserve).not.toHaveBeenCalled();
    expect(deps.save).toHaveBeenCalledWith(userId, jobTargetId, text);
    expect(deps.enqueue).toHaveBeenCalledWith({ userId, jobTargetId, requestId: 'request-1' });
  });
  it('renders sparse static pages only after reserving user budget', async () => {
    const { deps } = fixture();
    deps.fetch.mockResolvedValue(response('<div id="app"></div><script>fake words</script>'));
    await processJobTargetFetch(event, deps);
    expect(deps.reserve).toHaveBeenCalledWith(userId);
    expect(deps.scrape).toHaveBeenCalledWith('https://jobs.example/');
    expect(deps.reserve.mock.invocationCallOrder[0]).toBeLessThan(deps.scrape.mock.invocationCallOrder[0]);
    expect(deps.save).toHaveBeenCalledWith(userId, jobTargetId, text);
  });
  it('does not use a caller-controlled URL from the envelope', async () => {
    const { deps } = fixture();
    await processJobTargetFetch({ ...event, payload: { jobTargetId, url: 'http://localhost/' } }, deps);
    expect(deps.fetch.mock.calls[0][0]).toBe('https://jobs.example/');
  });
  it('skips deleted/foreign targets and never resurrects a concurrently deleted target', async () => {
    const { deps } = fixture();
    deps.load.mockResolvedValueOnce(null as never);
    await processJobTargetFetch(event, deps);
    expect(deps.fetch).not.toHaveBeenCalled();
    deps.save.mockResolvedValueOnce(false);
    await processJobTargetFetch(event, deps);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
  it('passes pasted text directly to parsing without fetching or imposing the URL word threshold', async () => {
    const { stored, deps } = fixture();
    stored.url = null; stored.text = 'Python required.';
    await processJobTargetFetch(event, deps);
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.scrape).not.toHaveBeenCalled();
    expect(deps.enqueue).toHaveBeenCalledOnce();
  });
  it('retries queue failure from saved text without another fetch or browser', async () => {
    const { deps } = fixture();
    deps.fetch.mockResolvedValue(response('empty'));
    deps.enqueue.mockRejectedValueOnce(new Error('queue offline'));
    await expect(processJobTargetFetch(event, deps)).rejects.toThrow('Job parsing queue unavailable');
    await processJobTargetFetch(event, deps);
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(deps.scrape).toHaveBeenCalledOnce();
    expect(deps.enqueue).toHaveBeenCalledTimes(2);
  });
  it('fails closed on unavailable budget and rejects sparse rendered results', async () => {
    const { deps } = fixture(); deps.fetch.mockResolvedValue(response('empty'));
    deps.reserve.mockRejectedValueOnce(new Error('Redis offline'));
    await expect(processJobTargetFetch(event, deps)).rejects.toThrow('Redis offline');
    expect(deps.scrape).not.toHaveBeenCalled();
    deps.scrape.mockResolvedValueOnce('too short');
    await expect(processJobTargetFetch(event, deps)).rejects.toBeInstanceOf(NonRetryableError);
    expect(deps.save).not.toHaveBeenCalled();
  });
  it('refuses permanent SSRF failures without falling back to a browser', async () => {
    const { deps } = fixture();
    deps.fetch.mockRejectedValue(new SafeFetchError('BLOCKED_ADDRESS', 'private'));
    await expect(processJobTargetFetch(event, deps)).rejects.toBeInstanceOf(NonRetryableError);
    expect(deps.failed).toHaveBeenCalledWith(userId, jobTargetId, 'BLOCKED_ADDRESS');
    expect(deps.scrape).not.toHaveBeenCalled();
  });
  it.each(['TIMEOUT', 'DNS_FAILED', 'REQUEST_FAILED'] as const)('keeps %s failures retryable', async code => {
    const { deps } = fixture();
    deps.fetch.mockRejectedValueOnce(new SafeFetchError(code, 'transport failed'));
    await expect(processJobTargetFetch(event, deps)).rejects.toBeInstanceOf(RetryableError);
  });
  it('does not persist text after a database failure or HTTP/encoding failure', async () => {
    const { deps } = fixture();
    deps.save.mockRejectedValueOnce(new Error('database offline'));
    await expect(processJobTargetFetch(event, deps)).rejects.toThrow('database offline');
    expect(deps.enqueue).not.toHaveBeenCalled();
    deps.fetch.mockResolvedValueOnce({ ...response(), status: 503 });
    await expect(processJobTargetFetch(event, deps)).rejects.toThrow('HTTP');
    deps.fetch.mockResolvedValueOnce({ ...response(), headers: { 'content-encoding': 'gzip' } });
    await expect(processJobTargetFetch(event, deps)).rejects.toThrow('Encoded');
  });
  it.each([{}, { ...event, userId: 'other' }, { ...event, type: 'wrong' }, { ...event, schemaVersion: 2 }])('rejects malformed envelopes', async value => {
    const { deps } = fixture();
    await expect(processJobTargetFetch(value, deps)).rejects.toBeInstanceOf(NonRetryableError);
    expect(deps.load).not.toHaveBeenCalled();
  });
  it('cleans static navigation and scripts and separates block words', () => {
    expect(staticJobText('<nav>ignore</nav><main><p>Python</p><div>SQL</div><script>ignore</script></main><footer>ignore</footer>')).toBe('Python SQL');
  });
});

describe('rate budget and runtime wiring', () => {
  it('uses a single atomic Redis sliding-window reservation with a hashed user key', async () => {
    await reserveScrape(userId);
    expect(mocks.eval).toHaveBeenCalledWith(SCRAPE_LIMIT_SCRIPT, 1, expect.stringMatching(/^jd:scrape-limit:[a-f\d]{64}$/), expect.any(String));
    mocks.eval.mockResolvedValueOnce(0);
    await expect(reserveScrape(userId)).rejects.toThrow('3 renders');
    mocks.status = 'end';
    await expect(reserveScrape(userId)).rejects.toThrow('unavailable');
    mocks.status = 'ready'; mocks.eval.mockRejectedValueOnce(new Error('command failed'));
    await expect(reserveScrape(userId)).rejects.toBeInstanceOf(RetryableError);
  });
  it('registers relay routing idempotently without launching a browser', () => {
    registerJobTargetSubmittedConsumer(); registerJobTargetSubmittedConsumer();
    expect(getQueuesForEvent('jobtarget.submitted')).toEqual([QueueNames.JD_FETCH]);
  });
  it('starts and drains a single ai worker', async () => {
    mocks.createWorker.mockReturnValue({ close: mocks.close });
    expect(startJobTargetFetchWorker()).toBe(startJobTargetFetchWorker());
    expect(mocks.createWorker).toHaveBeenCalledWith(QueueNames.JD_FETCH, expect.any(Function), { concurrency: 1 });
    await stopJobTargetFetchWorker(); await stopJobTargetFetchWorker();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('default storage filters every read/write by owner and enqueues a stable parsing job', async () => {
    mocks.findOne.mockReturnValue({ lean: async () => ({ text, url: null, status: 'submitted' }) });
    mocks.updateOne.mockResolvedValue({ matchedCount: 1 });
    await processJobTargetFetch(event);
    expect(mocks.findOne).toHaveBeenCalledWith({ _id: jobTargetId, userId });
    expect(mocks.updateOne).toHaveBeenCalledWith({ _id: jobTargetId, userId }, { $set: { text, status: 'ready', failureReason: null } });
    expect(mocks.add).toHaveBeenCalledWith('jd-parse', { userId, jobTargetId, requestId: 'request-1' }, expect.objectContaining({ jobId: `jd-parse-${jobTargetId}`, attempts: 3 }));
  });
});
