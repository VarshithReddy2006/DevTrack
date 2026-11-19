import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { randomUUID } from 'node:crypto';
import { JobTarget } from '../src/db/models/jobTarget.model.js';
import { SafeFetchError } from '../src/modules/job-targets/safeFetch.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), scrape: vi.fn(), add: vi.fn(), eval: vi.fn() }));
vi.mock('../src/shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ add: mocks.add }) }));
vi.mock('../src/shared/redis/index.js', () => ({ getRedisClient: () => ({ status: 'ready', eval: mocks.eval }) }));
vi.mock('../src/modules/job-targets/safeFetch.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/modules/job-targets/safeFetch.js')>();
  return { ...actual, safeFetch: mocks.fetch };
});
vi.mock('../src/modules/job-targets/workers/headlessScraper.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/modules/job-targets/workers/headlessScraper.js')>();
  return { ...actual, scrapeJobText: mocks.scrape };
});
const { processJobTargetFetch } = await import('../src/modules/job-targets/workers/jobTargetFetch.worker.js');

let server: MongoMemoryServer | undefined;
const userId = '111111111111111111111111';
const foreign = '333333333333333333333333';
const text = 'Build reliable distributed systems with TypeScript. '.repeat(40).trim();
const event = (id: unknown, owner = userId) => ({ type: 'jobtarget.submitted', schemaVersion: 1, userId: owner,
  payload: { jobTargetId: String(id) }, correlationId: 'request-1' });

beforeAll(async () => {
  // Always own the server and database; never read a URI from application .env or shell.
  server = await MongoMemoryServer.create({ binary: { version: '7.0.14' },
    instance: { dbName: 'job_fetch_' + randomUUID().replaceAll('-', '') } });
  await mongoose.connect(server.getUri());
});
beforeEach(() => { vi.resetAllMocks(); mocks.eval.mockResolvedValue(1); });
afterEach(async () => { await JobTarget.deleteMany({}); });
afterAll(async () => { await mongoose.disconnect(); await server?.stop(); });

it('persists rendered text on the owned target and queues parsing after the write', async () => {
  const target = await JobTarget.create({ userId, url: 'https://jobs.example/' });
  mocks.fetch.mockResolvedValue({ status: 200, url: target.url, headers: {}, body: Buffer.from('<main id="app"></main>') });
  mocks.scrape.mockResolvedValue(text);
  mocks.add.mockImplementation(async () => {
    expect(await JobTarget.findById(target._id).lean()).toMatchObject({ status: 'ready', text, failureReason: null });
  });
  await processJobTargetFetch(event(target._id));
  expect(mocks.scrape).toHaveBeenCalledOnce();
  expect(mocks.add).toHaveBeenCalledWith('jd-parse', expect.objectContaining({ userId }), expect.objectContaining({ jobId: `jd-parse-${target._id}` }));
});

it('does not fetch or write another owner’s target', async () => {
  const target = await JobTarget.create({ userId: foreign, url: 'https://jobs.example/' });
  await processJobTargetFetch(event(target._id));
  expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.add).not.toHaveBeenCalled();
  expect((await JobTarget.findById(target._id).lean())?.status).toBe('submitted');
});

it('retains a safe failure code and sends no parsing job on SSRF refusal', async () => {
  const target = await JobTarget.create({ userId, url: 'http://localhost/' });
  mocks.fetch.mockRejectedValueOnce(new SafeFetchError('BLOCKED_HOST', 'do not persist fetched content'));
  await expect(processJobTargetFetch(event(target._id))).rejects.toThrow('BLOCKED_HOST');
  expect(await JobTarget.findById(target._id).lean()).toMatchObject({ status: 'failed', failureReason: 'BLOCKED_HOST', text: null });
  expect(mocks.add).not.toHaveBeenCalled();
});

it('does not recreate a target deleted while rendering', async () => {
  const target = await JobTarget.create({ userId, url: 'https://jobs.example/' });
  mocks.fetch.mockResolvedValueOnce({ status: 200, url: target.url, headers: {}, body: Buffer.from('<main></main>') });
  mocks.scrape.mockImplementationOnce(async () => { await JobTarget.deleteOne({ _id: target._id }); return text; });
  await processJobTargetFetch(event(target._id));
  expect(await JobTarget.findById(target._id)).toBeNull(); expect(mocks.add).not.toHaveBeenCalled();
});

it('retries a failed queue handoff from saved text without refetching', async () => {
  const target = await JobTarget.create({ userId, text, status: 'submitted' });
  mocks.add.mockRejectedValueOnce(new Error('queue disconnected'));
  await expect(processJobTargetFetch(event(target._id))).rejects.toThrow('Job parsing queue unavailable');
  expect(await JobTarget.findById(target._id).lean()).toMatchObject({ status: 'ready', text, failureReason: null });
  mocks.add.mockResolvedValueOnce(undefined);
  await processJobTargetFetch(event(target._id));
  expect(mocks.fetch).not.toHaveBeenCalled(); expect(mocks.scrape).not.toHaveBeenCalled();
});
