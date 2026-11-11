import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedPlatform } from '../../../db/models/connectedPlatform.model.js';

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getReadinessDsaQueue: () => ({ add: mocks.enqueue }) }));
vi.mock('../../../shared/redis/syncLock.service.js', () => ({ acquireSyncLockWithRetry: mocks.acquire, releaseSyncLock: mocks.release }));
vi.mock('../../../modules/activity/activity.service.js', () => ({ createActivity: vi.fn(), incrementDailyActivity: vi.fn() }));
vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitSyncStarted: vi.fn(), emitSyncCompleted: vi.fn(), emitSyncFailed: vi.fn() } }));
vi.mock('../../../shared/circuit-breaker/circuitBreaker.js', () => ({
  circuitBreakers: Object.fromEntries(['leetcode', 'codeforces', 'codechef', 'github'].map(name => [name, { execute: (run: () => Promise<unknown>) => run() }])),
  CircuitOpenError: class extends Error {},
}));

import { syncPlatform } from '../../../modules/platform-sync/sync.service.js';
const owner = new Types.ObjectId();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.acquire.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.enqueue.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('codechef.com')) return new Response('<section class="problems-solved"><h5>Total Problems Solved: 0</h5></section>');
    if (url.includes('leetcode.com/graphql')) return Response.json({ data: {
      matchedUser: { submitStatsGlobal: { acSubmissionNum: [] }, submissionCalendar: '{}' },
      recentAcSubmissionList: [],
    } });
    if (url.includes('user.info')) return Response.json({ status: 'OK', result: [{ handle: 'synthetic' }] });
    if (url.includes('codeforces.com')) return Response.json({ status: 'OK', result: [] });
    if (url.includes('api.github.com/users')) return Response.json(url.includes('/repos') ? [] : { public_repos: 0 });
    if (url.includes('alfa-leetcode-api')) return Response.json({ contestHistory: [] });
    throw new Error(`Unexpected external request: ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());
async function connect(platformName: string) {
  await ConnectedPlatform.create({ userId: owner, platformName, username: 'synthetic', profileUrl: 'https://example.test/profile' });
}

describe('shared HTTP/worker sync readiness trigger', () => {
  it.each(['leetcode', 'codeforces', 'codechef'])('enqueues after a successful %s sync has persisted freshness', async platform => {
    await connect(platform);
    mocks.enqueue.mockImplementationOnce(async () => {
      const stored = await ConnectedPlatform.findOne({ userId: owner, platformName: platform }).lean();
      expect(stored?.syncStatus).toBe('success');
      expect(stored?.lastSyncedAt).toBeInstanceOf(Date);
    });
    expect((await syncPlatform(owner.toHexString(), platform)).success).toBe(true);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith('post-sync-readiness', { userId: owner.toHexString(), platform });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('does not enqueue for a GitHub sync', async () => {
    await connect('github');
    expect((await syncPlatform(owner.toHexString(), 'github')).success).toBe(true);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('does not enqueue when the platform is absent or a sync lock is unavailable', async () => {
    expect((await syncPlatform(owner.toHexString(), 'leetcode')).success).toBe(false);
    mocks.acquire.mockResolvedValueOnce(false);
    expect((await syncPlatform(owner.toHexString(), 'codeforces')).success).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('does not turn a persisted sync into a failure when readiness enqueue fails', async () => {
    await connect('codeforces');
    mocks.enqueue.mockRejectedValueOnce(new Error('queue offline'));
    expect((await syncPlatform(owner.toHexString(), 'codeforces')).success).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('does not enqueue on a provider failure', async () => {
    await connect('leetcode');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    expect((await syncPlatform(owner.toHexString(), 'leetcode')).success).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
