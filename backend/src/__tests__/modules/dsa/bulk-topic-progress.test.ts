import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DsaProblem, DsaTopicProgress } from '../../../db/models/index.js';
import { errorHandler } from '../../../middleware/error.js';
import dsaRoutes from '../../../modules/dsa/dsa.routes.js';
import { bulkUpdateStatus } from '../../../modules/dsa/dsa.service.js';

// Same HTTP boundary as the existing DSA route suite. Validation, controllers,
// services, models and disposable MongoDB are real; external identity is fixed.
vi.mock('../../../middleware/index.js', async () => {
  const { validateBody } = await import('../../../middleware/validation.js');
  const { asyncHandler } = await import('../../../middleware/error.js');
  const { commonErrors } = await import('../../../shared/response.js');
  return { validateBody, asyncHandler, authMiddleware: [(req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.get('authorization') !== 'Bearer test-owner') { commonErrors.unauthorized(res); return; }
    Object.assign(req, { user: { id: '000000000000000000000001' } }); next();
  }] };
});

const userId = new Types.ObjectId('000000000000000000000001');
let server: Server;
let base: string;
beforeAll(async () => {
  await Promise.all([DsaProblem.init(), DsaTopicProgress.init()]);
  const app = express(); app.use(express.json()); app.use('/api/v1/dsa', dsaRoutes); app.use(errorHandler);
  server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); listener.once('error', reject);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/dsa`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
async function request(method: string, route: string, body?: unknown) {
  const response = await fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-owner' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function create(category = 'graphs', difficulty = 'easy', platform = 'leetcode') {
  const response = await request('POST', '/problems', { title: 'Synthetic topic probe', platform, category, difficulty, tags: [], url: 'https://example.test/problem' });
  expect(response.status).toBe(201); return response.body.data.id as string;
}
async function bulk(id: string, status: string) {
  const result = await request('PATCH', '/problems/bulk-status', { problemIds: [id], status });
  expect(result.status).toBe(200); return result;
}

describe('bulk topic-progress consistency', () => {
  it.each(['easy', 'medium', 'hard'])('reconciles a valid %s solve across storage and readers', async difficulty => {
    const id = await create('graphs', difficulty); await bulk(id, 'solved');
    const stored = await DsaTopicProgress.findOne({ userId, topicName: 'graphs' }).lean();
    const stats = await request('GET', '/stats'), topics = await request('GET', '/topics'), dashboard = await request('GET', '/dashboard');
    expect((await DsaProblem.findById(id).lean())?.status).toBe('solved');
    expect(stats.body.data.totalSolved).toBe(1);
    expect(stored).toMatchObject({ totalProblems: 1, solvedCount: 1, [`${difficulty}Solved`]: 1 });
    expect(topics.body.data.topics.find((t: { topicName: string }) => t.topicName === 'graphs')).toMatchObject({ solvedCount: 1, solveRate: 100 });
    expect(dashboard.body.data.topics.find((t: { name: string }) => t.name === 'graphs')).toMatchObject({ progress: 100 });
  });
  it.each(['attempted', 'unsolved', 'revisit'])('reconciles a previously consistent solve reopened to %s', async status => {
    const id = await create();
    await DsaProblem.updateOne({ _id: id }, { $set: { status: 'solved', solvedAt: new Date() } });
    await DsaTopicProgress.updateOne({ userId, topicName: 'graphs' }, { $set: { solvedCount: 1, easySolved: 1 } });
    await bulk(id, status);
    expect((await DsaProblem.findById(id).lean())?.status).toBe(status);
    expect(await DsaTopicProgress.findOne({ userId, topicName: 'graphs' }).lean()).toMatchObject({ totalProblems: 1, solvedCount: 0, easySolved: 0 });
  });
  it.each([
    ['LeetCode Problems', 'leetcode'], ['Competitive Programming', 'codeforces'],
    ['CodeChef Problems', 'leetcode'], ['General', 'leetcode'],
  ])('preserves existing imported contributions when a valid category collides with %s', async (category, platform) => {
    // Exact numeric shape/key used by updatePlatformTopicAnalytics().
    const imported = await DsaTopicProgress.create({ userId, topicName: category, totalProblems: 100, solvedCount: 100, easyCount: 100, easySolved: 100 });
    const unrelated = await DsaTopicProgress.create({ userId, topicName: category === 'CodeChef Problems' ? 'General' : 'CodeChef Problems', totalProblems: 50, solvedCount: 50, easyCount: 50, easySolved: 50 });
    // Legacy state formerly accepted by POST. New creation is tested separately.
    const legacy = await DsaProblem.create({ userId, externalId: 'legacy', title: 'Legacy manual problem', category, platform, difficulty: 'easy', url: 'https://example.test/legacy', status: 'unsolved' });
    const id = legacy._id.toString();
    await DsaTopicProgress.updateOne({ _id: imported._id }, { $inc: { totalProblems: 1, easyCount: 1 } });
    expect(await DsaTopicProgress.findOne({ userId, topicName: category }).lean()).toMatchObject({ totalProblems: 101, solvedCount: 100 });
    const before = await DsaTopicProgress.findById(imported._id).lean();
    await bulk(id, 'solved');
    const stored = await DsaTopicProgress.findById(imported._id).lean();
    expect((await DsaProblem.findById(id).lean())?.status).toBe('solved');
    expect(await DsaTopicProgress.findById(unrelated._id).lean()).toEqual(unrelated.toObject());
    expect(stored?._id.toString()).toBe(imported._id.toString());
    // No assumption about overlap: even the original 100 must not be erased.
    expect(stored?.totalProblems).toBeGreaterThanOrEqual(100);
    expect(stored?.solvedCount).toBeGreaterThanOrEqual(100);
    expect(stored?.easySolved).toBeGreaterThanOrEqual(100);
    expect(stored).toEqual(before);
    const normal = await create(); await bulk(normal, 'solved');
    expect(await DsaTopicProgress.findOne({ userId, topicName: 'graphs' }).lean()).toMatchObject({ solvedCount: 1 });
    expect(await DsaTopicProgress.findById(imported._id).lean()).toEqual(before);
  });
  it('control: initial manual totals and unknown ID request stay unchanged', async () => {
    await create();
    const before = await DsaTopicProgress.findOne({ userId, topicName: 'graphs' }).lean();
    await bulk(new Types.ObjectId().toHexString(), 'solved');
    expect(await DsaTopicProgress.findOne({ userId, topicName: 'graphs' }).lean()).toEqual(before);
    expect(before).toMatchObject({ totalProblems: 1, solvedCount: 0, easySolved: 0 });
  });
});

describe('reserved category creation boundary', () => {
  it.each(['LeetCode Problems', 'Competitive Programming', 'CodeChef Problems', 'General', ' LeetCode Problems ', '\tGeneral\n'])('rejects reserved creation %j without writes', async category => {
    const summary = await DsaTopicProgress.create({ userId, topicName: category.trim(), totalProblems: 100, solvedCount: 100 });
    const response = await request('POST', '/problems', { title: 'Rejected', category, platform: 'leetcode', difficulty: 'easy', tags: [], url: 'https://example.test/rejected' });
    expect(response.status).toBe(400);
    expect(await DsaProblem.countDocuments({ userId })).toBe(0);
    expect(await DsaTopicProgress.findById(summary._id).lean()).toEqual(summary.toObject());
  });
  it.each(['graphs', 'dp', 'arrays', 'trees', ' Graphs ', 'general', 'General algorithms'])('accepts ordinary category %j without normalizing it', async category => {
    const id = await create(category);
    expect((await DsaProblem.findById(id).lean())?.category).toBe(category);
  });
});

async function seed(category = 'graphs', difficulty = 'easy', status = 'unsolved', owner = userId) {
  const row = await DsaProblem.create({ userId: owner, externalId: new Types.ObjectId().toHexString(), title: 'Seeded synthetic', category, difficulty, status, platform: 'leetcode', url: 'https://example.test/seeded', solvedAt: status === 'solved' ? new Date('2026-01-01') : null });
  return row._id.toString();
}
async function cached(category = 'graphs') { return DsaTopicProgress.findOne({ userId, topicName: category }).lean(); }

describe('bulk reconciliation boundaries', () => {
  it('repairs multiple categories and difficulties with duplicates, mixed statuses and replays', async () => {
    const a = await seed(), b = await seed('graphs', 'medium', 'solved'), c = await seed('trees', 'hard', 'attempted');
    const unrelated = await DsaTopicProgress.create({ userId, topicName: 'untouched', totalProblems: 7, solvedCount: 3 });
    const foreign = await seed('foreign', 'hard', 'unsolved', new Types.ObjectId());
    const result = await bulkUpdateStatus(userId.toString(), [a, a, b, c, foreign, new Types.ObjectId().toHexString()], 'solved');
    expect(result).toBe(3); // Existing updateMany also modifies solvedAt on b.
    expect(await cached()).toMatchObject({ totalProblems: 2, solvedCount: 2, easyCount: 1, easySolved: 1, mediumCount: 1, mediumSolved: 1 });
    expect(await cached('trees')).toMatchObject({ totalProblems: 1, solvedCount: 1, hardCount: 1, hardSolved: 1 });
    await bulkUpdateStatus(userId.toString(), [a, b, c], 'solved');
    expect(await cached()).toMatchObject({ solvedCount: 2 });
    expect(await DsaTopicProgress.findById(unrelated._id).lean()).toEqual(unrelated.toObject());
    expect((await DsaProblem.findById(foreign).lean())?.status).toBe('unsolved');
    expect(await cached('foreign')).toBeNull();
  });
  it('retains modifiedCount and solvedAt behavior for no-op/replayed status requests', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-02'));
    const id = await seed('graphs', 'easy', 'solved');
    expect(await bulkUpdateStatus(userId.toString(), [id, id], 'solved')).toBe(1);
    expect((await DsaProblem.findById(id).lean())?.solvedAt).toEqual(new Date('2026-01-02'));
    expect(await bulkUpdateStatus(userId.toString(), [id], 'solved')).toBe(0);
    expect(await bulkUpdateStatus(userId.toString(), [id], 'revisit')).toBe(1);
    expect((await DsaProblem.findById(id).lean())?.solvedAt).toEqual(new Date('2026-01-02'));
    expect(await bulkUpdateStatus(userId.toString(), [id], 'revisit')).toBe(0);
    expect(await cached()).toMatchObject({ solvedCount: 0 });
  });
  it('rejects invalid/unauthenticated requests without changing problems or topic rows', async () => {
    const id = await create(); const before = await cached();
    expect((await request('PATCH', '/problems/bulk-status', { problemIds: [id], status: 'invalid' })).status).toBe(400);
    const response = await fetch(`${base}/problems/bulk-status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ problemIds: [id], status: 'solved' }) });
    expect(response.status).toBe(401);
    expect((await DsaProblem.findById(id).lean())?.status).toBe('unsolved');
    expect(await cached()).toEqual(before);
  });
  it('reports a topic-write failure and repairs the persisted status on a repeated request', async () => {
    const id = await create();
    const write = vi.spyOn(DsaTopicProgress, 'updateOne').mockImplementationOnce(() => { throw new Error('Injected topic write failure'); });
    const failed = await request('PATCH', '/problems/bulk-status', { problemIds: [id], status: 'solved' });
    write.mockRestore();
    expect(failed.status).toBe(500);
    expect((await DsaProblem.findById(id).lean())?.status).toBe('solved');
    expect(await cached()).toMatchObject({ solvedCount: 0 });
    await bulk(id, 'solved');
    expect(await cached()).toMatchObject({ solvedCount: 1, easySolved: 1 });
  });
  it('supports existing topic documents with no version field', async () => {
    const id = await create();
    await DsaTopicProgress.collection.updateOne({ userId, topicName: 'graphs' }, { $unset: { __v: '' } });
    await bulk(id, 'solved');
    expect(await cached()).toMatchObject({ solvedCount: 1, easySolved: 1 });
  });
  it('handles concurrent first-time creation of the same missing topic cache', async () => {
    const a = await seed(), b = await seed();
    await Promise.all([bulkUpdateStatus(userId.toString(), [a], 'solved'), bulkUpdateStatus(userId.toString(), [b], 'solved')]);
    expect(await DsaTopicProgress.countDocuments({ userId, topicName: 'graphs' })).toBe(1);
    expect(await cached()).toMatchObject({ totalProblems: 2, solvedCount: 2 });
  });
  it('repairs normal categories in a mixed request while preserving a trimmed legacy reserved category', async () => {
    const id = await create(), legacy = await seed(' General ');
    const summary = await DsaTopicProgress.create({ userId, topicName: ' General ', totalProblems: 100, solvedCount: 100 });
    await bulkUpdateStatus(userId.toString(), [id, legacy], 'solved');
    expect(await cached()).toMatchObject({ solvedCount: 1 });
    expect((await DsaProblem.findById(legacy).lean())?.status).toBe('solved');
    expect(await DsaTopicProgress.findById(summary._id).lean()).toEqual(summary.toObject());
  });
  it('surfaces retry exhaustion instead of publishing unguarded stale counters', async () => {
    const id = await create();
    const blocked = vi.spyOn(DsaTopicProgress, 'updateOne').mockImplementation(() => Promise.resolve({ matchedCount: 0 }) as never);
    await expect(bulkUpdateStatus(userId.toString(), [id], 'solved')).rejects.toThrow('retry the bulk status update');
    expect(blocked).toHaveBeenCalledTimes(8);
    blocked.mockRestore();
    await bulk(id, 'solved');
    expect(await cached()).toMatchObject({ solvedCount: 1 });
  });
  it('surfaces a second-category failure and repairs both categories on retry', async () => {
    const a = await create(), b = await seed('trees');
    const original = DsaTopicProgress.updateOne.bind(DsaTopicProgress);
    const failure = vi.spyOn(DsaTopicProgress, 'updateOne');
    // Fail only the second publication, after one real topic update completed.
    let calls = 0;
    failure.mockImplementation(((...args: Parameters<typeof DsaTopicProgress.updateOne>) => {
      if (++calls === 2) throw new Error('Injected second publication failure');
      return original(...args);
    }) as typeof DsaTopicProgress.updateOne);
    await expect(bulkUpdateStatus(userId.toString(), [a, b], 'solved')).rejects.toThrow('second publication');
    expect(await DsaProblem.countDocuments({ userId, status: 'solved' })).toBe(2);
    failure.mockRestore();
    await bulkUpdateStatus(userId.toString(), [a, b], 'solved');
    expect(await cached()).toMatchObject({ solvedCount: 1 });
    expect(await cached('trees')).toMatchObject({ solvedCount: 1 });
  });
  it.each(['different', 'same', 'opposing'])('does not let a stale %s-problem recomputation overwrite a newer request', async mode => {
    const a = await create(), b = mode === 'different' ? await seed() : a;
    const original = DsaProblem.aggregate.bind(DsaProblem);
    let release!: () => void, signal!: () => void;
    const paused = new Promise<void>(resolve => { signal = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const spy = vi.spyOn(DsaProblem, 'aggregate').mockImplementation(((...args: Parameters<typeof DsaProblem.aggregate>) => {
      const query = original(...args);
      if (!first) return query;
      first = false;
      // Real database aggregate executes first; only response delivery is paused.
      return query.exec().then(async rows => { signal(); await resume; return rows; });
    }) as typeof DsaProblem.aggregate);
    const older = bulkUpdateStatus(userId.toString(), [a], 'solved');
    try {
      await paused;
      await bulkUpdateStatus(userId.toString(), [b], mode === 'opposing' ? 'attempted' : 'solved');
    } finally { release(); await older; spy.mockRestore(); }
    const solved = await DsaProblem.countDocuments({ userId, category: 'graphs', status: 'solved' });
    expect(solved).toBe(mode === 'opposing' ? 0 : mode === 'different' ? 2 : 1);
    expect(await cached()).toMatchObject({ totalProblems: mode === 'different' ? 2 : 1, solvedCount: solved, easySolved: solved });
  });
});
