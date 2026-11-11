import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ConnectedPlatform, PlatformStats, DsaProblem, DsaSubmission, DailyActivity, SyncJob } from '../../../db/models/index.js';
import { getAdapter } from '../../../modules/platform-sync/adapters/index.js';
import { syncPlatform, ingestLeetCodeSubmissions } from '../../../modules/platform-sync/sync.service.js';
import { eventBus } from '../../../shared/sse/index.js';
import { releaseSyncLock, acquireSyncLockWithRetry } from '../../../shared/redis/syncLock.service.js';

const infra = vi.hoisted(() => ({ readiness: vi.fn() }));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitSyncStarted: vi.fn(), emitSyncCompleted: vi.fn(), emitSyncFailed: vi.fn() } }));
vi.mock('../../../shared/redis/syncLock.service.js', () => ({
  acquireSyncLockWithRetry: vi.fn().mockResolvedValue(true), releaseSyncLock: vi.fn(),
}));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getReadinessDsaQueue: () => ({ add: infra.readiness }) }));
vi.mock('../../../modules/daily-challenge/daily-challenge.service.js', () => ({ checkChallengeCompletion: vi.fn().mockResolvedValue(false) }));

const owner = '000000000000000000000092';
const other = '000000000000000000000093';
const timestamp = Math.floor(Date.now() / 1000);
const rows = [1, 2].map(id => ({ id: String(id), title: 'Two Sum', titleSlug: 'two-sum', timestamp: String(timestamp - id) }));
function provider(fail = false) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (fail) return new Response('not found', { status: 404 });
    if (url.includes('leetcode.com/graphql')) {
      const query = JSON.parse(String(init?.body)).query as string;
      return Response.json({ data: query.includes('recentAcSubmissions') ? { recentAcSubmissionList: rows }
        : { matchedUser: { submitStatsGlobal: { acSubmissionNum: [{ difficulty: 'All', count: 2 }] }, submissionCalendar: '{}' } } });
    }
    if (url.includes('alfa-leetcode')) return Response.json({ contestHistory: [] });
    if (url.includes('user.info')) return Response.json({ status: 'OK', result: [{ handle: 'synthetic', rating: 1500 }] });
    if (url.includes('user.rating')) return Response.json({ status: 'OK', result: [] });
    if (url.includes('user.status')) return Response.json({ status: 'OK', result: [{ id: 1, verdict: 'OK', creationTimeSeconds: timestamp,
      problem: { contestId: 4, index: 'A', name: 'Watermelon' } }] });
    if (url.includes('codechef.com')) return new Response('<div class="rating-number">1650</div>Total Problems Solved: 12');
    if (url.includes('/repos?')) return Response.json([{ stargazers_count: 5, language: 'TypeScript' }]);
    if (url.includes('api.github.com')) return Response.json({ public_repos: 3, followers: 4 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeAll(async () => { await Promise.all([DsaProblem.init(), DsaSubmission.init()]); });
beforeEach(() => { vi.clearAllMocks(); provider(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['leetcode', 'codeforces', 'codechef', 'github'])('persists %s through the actual registered adapter', async platformName => {
  const adapter = getAdapter(platformName);
  const adapterCall = vi.spyOn(adapter, 'sync');
  await ConnectedPlatform.create({ userId: owner, platformName, username: 'synthetic', profileUrl: 'https://example.test' });
  expect(await syncPlatform(owner, platformName)).toMatchObject({ success: true });
  expect(adapterCall).toHaveBeenCalledExactlyOnceWith('synthetic');
  expect(await PlatformStats.findOne({ userId: owner, platformName })).not.toBeNull();
  expect(await ConnectedPlatform.findOne({ userId: owner, platformName })).toMatchObject({ syncStatus: 'success' });
  expect(await SyncJob.findOne({ userId: owner, platformName })).toMatchObject({ status: 'completed' });
  expect(eventBus.emitSyncCompleted).toHaveBeenCalledTimes(1);
  expect(eventBus.emitSyncStarted).toHaveBeenCalledExactlyOnceWith(owner, platformName);
  expect(vi.mocked(eventBus.emitSyncStarted).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(eventBus.emitSyncCompleted).mock.invocationCallOrder[0]);
  expect(releaseSyncLock).toHaveBeenCalledExactlyOnceWith(owner, platformName);
  if (platformName === 'leetcode') {
    expect((await DsaSubmission.find({ userId: owner }).sort({ externalId: 1 })).map(sub => sub.externalId)).toEqual(['1', '2']);
    expect((await DsaProblem.findOne({ userId: owner }))!.submissionCount).toBe(2);
  }
  if (platformName === 'codeforces') expect(await DsaSubmission.countDocuments({ userId: owner })).toBe(1);
  if (platformName === 'codechef' || platformName === 'github') expect(await DsaSubmission.countDocuments({ userId: owner })).toBe(0);
  expect(infra.readiness).toHaveBeenCalledTimes(platformName === 'github' ? 0 : 1);
});

it('deduplicates concurrent submission imports and keeps problem timestamps and user histories separate', async () => {
  await Promise.all(Array.from({ length: 5 }, () => ingestLeetCodeSubmissions(owner, 'synthetic')));
  expect(await DsaSubmission.countDocuments({ userId: owner })).toBe(2);
  const problem = await DsaProblem.findOne({ userId: owner });
  expect(problem).toMatchObject({ submissionCount: 2,
    solvedAt: new Date((timestamp - 2) * 1000), lastSubmittedAt: new Date((timestamp - 1) * 1000) });
  expect((await DailyActivity.find({ userId: owner })).reduce((sum, day) => sum + day.count, 0)).toBe(2);
  expect(await ingestLeetCodeSubmissions(owner, 'synthetic')).toBe(0);
  expect(await ingestLeetCodeSubmissions(other, 'synthetic')).toBe(2);
  expect(await DsaSubmission.countDocuments({ userId: other })).toBe(2);
});

it('reports adapter failure without overwriting saved stats, and releases the sync lock', async () => {
  await ConnectedPlatform.create({ userId: owner, platformName: 'leetcode', username: 'synthetic', profileUrl: 'https://example.test' });
  await PlatformStats.create({ userId: owner, platformName: 'leetcode', username: 'synthetic', totalSolved: 99 });
  provider(true);
  expect(await syncPlatform(owner, 'leetcode')).toMatchObject({ success: false });
  expect((await PlatformStats.findOne({ userId: owner }))!.totalSolved).toBe(99);
  expect(await SyncJob.findOne({ userId: owner })).toMatchObject({ status: 'failed' });
  expect(eventBus.emitSyncFailed).toHaveBeenCalledTimes(1);
  expect(releaseSyncLock).toHaveBeenCalledTimes(1);
});

it('respects the existing sync cooldown without changing the saved success status', async () => {
  const fetcher = provider();
  await ConnectedPlatform.create({ userId: owner, platformName: 'github', username: 'synthetic', profileUrl: 'https://example.test',
    syncStatus: 'success', lastSyncedAt: new Date() });
  expect(await syncPlatform(owner, 'github')).toMatchObject({ success: false, error: expect.stringContaining('Cooldown') });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await ConnectedPlatform.findOne({ userId: owner })).toMatchObject({ syncStatus: 'success' });
});

it('does not fetch for missing or disconnected platforms or when the mutex cannot be acquired', async () => {
  const fetcher = provider();
  expect(await syncPlatform(owner, 'github')).toMatchObject({ success: false });
  await ConnectedPlatform.create({ userId: owner, platformName: 'github', username: 'synthetic', profileUrl: 'https://example.test', isConnected: false });
  expect(await syncPlatform(owner, 'github')).toMatchObject({ success: false });
  vi.mocked(acquireSyncLockWithRetry).mockResolvedValueOnce(false);
  expect(await syncPlatform(owner, 'github')).toMatchObject({ success: false });
  expect(fetcher).not.toHaveBeenCalled();
});
