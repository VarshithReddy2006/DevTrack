import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DsaContest } from '../../../db/models/dsaContest.model.js';
import { DsaContestParticipation } from '../../../db/models/dsaContestParticipation.model.js';
import { UserSettings } from '../../../db/models/userSettings.model.js';
import { eventBus } from '../../../shared/sse/eventBus.js';
import * as sources from '../../../modules/contests/contestRatingSources.js';
import { syncContestRatings } from '../../../modules/contests/contestRatingSync.service.js';
import { enqueueContestRatingSyncs, processContestRatingJob, scheduleContestRatingSync, startContestRatingSyncWorker, stopContestRatingSyncWorker } from '../../../shared/jobs/contestRatingSyncWorker.js';

const state = vi.hoisted(() => ({ add: vi.fn(), rateLimit: vi.fn(), close: vi.fn(), create: vi.fn() }));
vi.mock('../../../shared/sse/eventBus.js', () => ({ eventBus: { publishEnvelope: vi.fn() } }));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ add: state.add }) }));
vi.mock('../../../shared/redis/client.js', () => ({ getRedisClient: vi.fn() }));
vi.mock('../../../shared/jobs/dlq.service.js', () => ({ createDlqWorker: (...args: unknown[]) => {
  state.create(...args); return { rateLimit: state.rateLimit, close: state.close };
} }));
vi.mock('bullmq', () => ({ Worker: class { static RateLimitError() { return new Error('bullmq:rateLimitExceeded'); } } }));

const result = (delta = 45): sources.ContestResult => ({ rank: 12, score: 2300, problemsSolved: 3,
  ratingBefore: 1500, ratingAfter: 1500 + delta, ratingChange: delta });
const now = () => new Date();
async function contest(platform: 'codeforces' | 'leetcode' = 'codeforces', hoursAgo = 3) {
  return DsaContest.create({ platform, externalId: platform === 'codeforces' ? String(Math.floor(Math.random() * 1000000)) : `weekly-${Math.random()}`,
    contestName: 'Contest', kind: 'scheduled', startTime: new Date(Date.now() - (hoursAgo + 2) * 3600_000),
    endTime: new Date(Date.now() - hoursAgo * 3600_000) });
}
async function user(handle = 'Alpha', platform: 'codeforces' | 'leetcode' = 'codeforces') {
  const userId = new Types.ObjectId();
  await UserSettings.create({ userId, platforms: { [platform]: platform === 'codeforces' ? { handle } : { username: handle } } });
  return userId;
}

beforeAll(async () => { await Promise.all([DsaContest.init(), DsaContestParticipation.init(), UserSettings.init()]); });
beforeEach(() => {
  vi.clearAllMocks();
  state.add.mockResolvedValue({}); state.close.mockResolvedValue(undefined); state.rateLimit.mockResolvedValue(undefined);
  vi.spyOn(sources, 'fetchCodeforcesResults').mockResolvedValue(new Map([['alpha', result()]]));
  vi.spyOn(sources, 'fetchLeetcodeResult').mockResolvedValue(result(-12));
  vi.mocked(eventBus.publishEnvelope).mockResolvedValue(undefined);
});
afterEach(async () => { await stopContestRatingSyncWorker(); vi.restoreAllMocks(); });

describe('contest participation persistence and targeted events', () => {
  it.each([45, -12, 0])('persists rating delta %s with rank, score and solved count', async delta => {
    const entry = await contest(); const userId = await user();
    vi.mocked(sources.fetchCodeforcesResults).mockResolvedValue(new Map([['alpha', result(delta)]]));
    expect(await syncContestRatings(entry.id)).toEqual({ changed: 1, failed: 0 });
    expect(await DsaContestParticipation.findOne({ userId, contestId: entry._id }).lean()).toMatchObject({ ...result(delta), handle: 'Alpha', platform: 'codeforces' });
    expect(eventBus.publishEnvelope).toHaveBeenCalledExactlyOnceWith(userId.toString(), 'contest.rating_updated', expect.objectContaining({ contestId: entry.id, ratingChange: delta }));
  });

  it('does not duplicate records or emit unchanged results on repeated syncs', async () => {
    const entry = await contest(); await user();
    await syncContestRatings(entry.id);
    expect(await syncContestRatings(entry.id)).toEqual({ changed: 0, failed: 0 });
    expect(await DsaContestParticipation.countDocuments()).toBe(1);
    expect(eventBus.publishEnvelope).toHaveBeenCalledTimes(1);
  });

  it('the database enforces one participation per user/contest under races', async () => {
    const entry = await contest(); const userId = await user();
    const doc = { userId, contestId: entry._id, platform: 'codeforces', handle: 'Alpha', ...result(), observedAt: now() };
    const writes = await Promise.allSettled([DsaContestParticipation.create(doc), DsaContestParticipation.create(doc)]);
    expect(writes.filter(write => write.status === 'fulfilled')).toHaveLength(1);
    expect(await DsaContestParticipation.countDocuments()).toBe(1);
  });

  it('stores unrated/pending ratings as null and reconciles later published ratings', async () => {
    const entry = await contest(); await user();
    const unrated = { ...result(), ratingBefore: null, ratingAfter: null, ratingChange: null };
    vi.mocked(sources.fetchCodeforcesResults).mockResolvedValue(new Map([['alpha', unrated]]));
    await syncContestRatings(entry.id);
    expect(await DsaContestParticipation.findOne().lean()).toMatchObject(unrated);
    vi.mocked(sources.fetchCodeforcesResults).mockResolvedValue(new Map([['alpha', result()]]));
    expect((await syncContestRatings(entry.id)).changed).toBe(1);
    vi.mocked(sources.fetchCodeforcesResults).mockResolvedValue(new Map([['alpha', unrated]]));
    expect((await syncContestRatings(entry.id)).changed).toBe(0);
    expect((await DsaContestParticipation.findOne().lean())?.ratingChange).toBe(45);
  });

  it('does not overwrite a newer observation with an older result', async () => {
    const entry = await contest(); const userId = await user();
    await DsaContestParticipation.create({ userId, contestId: entry._id, platform: 'codeforces', handle: 'Alpha', ...result(99), observedAt: new Date(Date.now() + 60_000) });
    expect((await syncContestRatings(entry.id)).changed).toBe(0);
    expect((await DsaContestParticipation.findOne().lean())?.ratingChange).toBe(99);
    expect(eventBus.publishEnvelope).not.toHaveBeenCalled();
  });

  it('isolates handles and skips nonparticipants, disconnected handles, and unsupported platforms', async () => {
    const entry = await contest(); await user('Nobody');
    await user('Alpha', 'leetcode');
    await UserSettings.create({ userId: new Types.ObjectId() });
    await syncContestRatings(entry.id);
    expect(await DsaContestParticipation.countDocuments()).toBe(0);
    expect(eventBus.publishEnvelope).not.toHaveBeenCalled();
  });

  it('uses trimmed handles while checking the original linked account before saving', async () => {
    const entry = await contest(); await user(' Alpha ');
    expect((await syncContestRatings(entry.id)).changed).toBe(1);
  });

  it('does not save data for a handle disconnected during the provider request', async () => {
    const entry = await contest(); const userId = await user();
    vi.mocked(sources.fetchCodeforcesResults).mockImplementation(async () => {
      await UserSettings.updateOne({ userId }, { $set: { 'platforms.codeforces.handle': '' } });
      return new Map([['alpha', result()]]);
    });
    expect((await syncContestRatings(entry.id)).changed).toBe(0);
  });

  it('fetches Codeforces full standings once per contest for multiple linked users', async () => {
    const entry = await contest(); await user(); await user('Bravo');
    vi.mocked(sources.fetchCodeforcesResults).mockResolvedValue(new Map([['alpha', result()], ['bravo', result(-12)]]));
    expect((await syncContestRatings(entry.id)).changed).toBe(2);
    expect(sources.fetchCodeforcesResults).toHaveBeenCalledTimes(1);
  });

  it('reconciles LeetCode users independently, continues after downtime and retries without duplicates', async () => {
    const entry = await contest('leetcode'); await user('Alpha', 'leetcode'); await user('Bravo', 'leetcode');
    vi.mocked(sources.fetchLeetcodeResult).mockRejectedValueOnce(new Error('upstream offline')).mockResolvedValue(result(-12));
    await expect(syncContestRatings(entry.id)).rejects.toThrow('failed for 1 users');
    expect(await DsaContestParticipation.countDocuments()).toBe(1);
    await syncContestRatings(entry.id);
    expect(await DsaContestParticipation.countDocuments()).toBe(2);
    expect(eventBus.publishEnvelope).toHaveBeenCalledTimes(2);
  });

  it('does not fabricate participation or request results before the two-hour delay', async () => {
    const entry = await contest('leetcode', 1); await user('Alpha', 'leetcode');
    expect((await syncContestRatings(entry.id)).changed).toBe(0);
    expect(sources.fetchLeetcodeResult).not.toHaveBeenCalled();
    await entry.updateOne({ endTime: new Date(Date.now() - 3 * 3600_000) });
    vi.mocked(sources.fetchLeetcodeResult).mockResolvedValue(null);
    expect((await syncContestRatings(entry.id)).changed).toBe(0);
  });

  it('preserves saved history when SSE is unavailable', async () => {
    const entry = await contest(); await user();
    vi.mocked(eventBus.publishEnvelope).mockRejectedValue(new Error('Redis unavailable'));
    expect((await syncContestRatings(entry.id)).changed).toBe(1);
    expect(await DsaContestParticipation.countDocuments()).toBe(1);
  });
});

describe('sync pool scheduling and retry handling', () => {
  it('catches up only eligible contests and uses an hourly deterministic job ID', async () => {
    const eligible = await contest(); await contest('leetcode', 1); await contest('codeforces', 200);
    await DsaContest.create({ platform: 'atcoder', contestName: 'Other', kind: 'scheduled', endTime: new Date(Date.now() - 3 * 3600_000) });
    expect(await enqueueContestRatingSyncs()).toBe(1);
    expect(state.add).toHaveBeenCalledWith('contest-rating-sync', { task: 'sync', contestId: eligible.id }, expect.objectContaining({ attempts: 5, backoff: { type: 'exponential', delay: 5000 }, jobId: `contest-rating-${eligible.id}-${Math.floor(Date.now() / 3600_000)}` }));
  });

  it('registers a 15-minute repeatable sweep and a bounded startup catch-up', async () => {
    await scheduleContestRatingSync();
    expect(state.add).toHaveBeenCalledWith('contest-rating-sweep', { task: 'sweep' }, expect.objectContaining({ repeat: { every: 900_000 } }));
    expect(state.add).toHaveBeenCalledTimes(2);
  });

  it('starts once with provider-safe concurrency and drains on stop', async () => {
    const first = startContestRatingSyncWorker(); expect(startContestRatingSyncWorker()).toBe(first);
    expect(state.create).toHaveBeenCalledExactlyOnceWith('contest-rating-sync', processContestRatingJob, expect.objectContaining({ concurrency: 1, limiter: { max: 1, duration: 2100 } }));
    await stopContestRatingSyncWorker(); expect(state.close).toHaveBeenCalledTimes(1);
  });

  it('pauses the queue for Retry-After and requeues the rate-limited job', async () => {
    const entry = await contest(); await user(); startContestRatingSyncWorker();
    vi.mocked(sources.fetchCodeforcesResults).mockRejectedValue(new sources.ContestProviderRateLimit(120_000));
    await expect(processContestRatingJob({ data: { task: 'sync', contestId: entry.id } })).rejects.toThrow('bullmq:rateLimitExceeded');
    expect(state.rateLimit).toHaveBeenCalledExactlyOnceWith(120_000);
    expect(await DsaContestParticipation.countDocuments()).toBe(0);
  });

  it('propagates provider failures for exponential queue retries without poisoning other jobs', async () => {
    const entry = await contest(); await user();
    vi.mocked(sources.fetchCodeforcesResults).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(processContestRatingJob({ data: { task: 'sync', contestId: entry.id } })).rejects.toThrow('provider unavailable');
    expect(await processContestRatingJob({ data: { task: 'sync', contestId: entry.id } })).toEqual({ changed: 1, failed: 0 });
  });
});
