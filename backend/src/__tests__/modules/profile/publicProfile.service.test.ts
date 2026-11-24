import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicProfile } from '../../../db/models/publicProfile.model.js';
import { ProfileView } from '../../../db/models/profileView.model.js';
import { User } from '../../../db/models/user.model.js';
import { PublicProfileService, isCurrentProfileSnapshot } from '../../../modules/profile/publicProfile.service.js';
import { withDistributedLock } from '../../../shared/redis/distributedLock.js';

vi.mock('../../../shared/redis/distributedLock.js', () => ({ withDistributedLock: vi.fn() }));
const lock = vi.mocked(withDistributedLock);
let counter = 0;
async function published(version = 1) {
  const username = `stampede${counter++}`;
  const user = await User.create({ clerkId: username, username, displayName: username, email: `${username}@example.test` });
  await PublicProfile.create({ userId: user._id, username, slug: username, published: true, visibility: 'public', snapshot: { version } });
  return user;
}
const read = (username: string) => PublicProfileService.getPublicProfileByUsername(username, '127.0.0.1', 'public');
const score = { trustScore: 0, suspicionScore: 0, flags: [] };

beforeEach(() => {
  lock.mockImplementation(async (_key, task) => ({ executed: true, result: await task({} as never) }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); lock.mockReset(); });

describe('public snapshot request coalescing', () => {
  it('shares one heavy rebuild across 100 concurrent stale reads without sharing view accounting', async () => {
    const user = await published();
    const compute = vi.spyOn(PublicProfileService, 'computeProfile').mockImplementation(async userId => {
      await new Promise(resolve => setTimeout(resolve, 80));
      await PublicProfile.updateOne({ userId }, { $set: { 'snapshot.version': 2 } });
      return score;
    });
    const profiles = await Promise.all(Array.from({ length: 100 }, () => read(user.username)));
    expect(compute).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(profiles.every(profile => profile.snapshot.version === 2)).toBe(true);
    expect((await PublicProfile.findOne({ userId: user._id }))?.stats.profileViews).toBe(100);
  });

  it('rebuilds a missing legacy snapshot once for concurrent cold reads', async () => {
    const user = await published();
    await PublicProfile.collection.updateOne({ userId: user._id }, { $unset: { snapshot: '' } });
    const compute = vi.spyOn(PublicProfileService, 'computeProfile').mockImplementation(async userId => {
      await PublicProfile.updateOne({ userId }, { $set: { 'snapshot.version': 2 } });
      return score;
    });
    await Promise.all(Array.from({ length: 100 }, () => read(user.username)));
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild a current snapshot or serialize different profile owners', async () => {
    const [current, first, second] = await Promise.all([published(2), published(), published()]);
    let running = 0, peak = 0;
    const compute = vi.spyOn(PublicProfileService, 'computeProfile').mockImplementation(async userId => {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 50));
      await PublicProfile.updateOne({ userId }, { $set: { 'snapshot.version': 2 } });
      running--;
      return score;
    });
    await read(current.username);
    expect(compute).not.toHaveBeenCalled();
    await Promise.all([read(first.username), read(second.username)]);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
  });

  it('drops failed flights so a later request can rebuild successfully', async () => {
    const user = await published();
    const compute = vi.spyOn(PublicProfileService, 'computeProfile').mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      throw new Error('database unavailable');
    });
    const failed = await Promise.allSettled(Array.from({ length: 20 }, () => read(user.username)));
    expect(failed.every(result => result.status === 'rejected')).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    compute.mockImplementation(async userId => {
      await PublicProfile.updateOne({ userId }, { $set: { 'snapshot.version': 2 } });
      return score;
    });
    expect((await read(user.username)).snapshot.version).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('rechecks the version after acquiring the distributed lock', async () => {
    const user = await published();
    const compute = vi.spyOn(PublicProfileService, 'computeProfile');
    lock.mockImplementation(async (_key, task) => {
      await PublicProfile.updateOne({ userId: user._id }, { $set: { 'snapshot.version': 2 } });
      return { executed: true, result: await task({} as never) };
    });
    await read(user.username);
    expect(compute).not.toHaveBeenCalled();
  });

  it('waits for another replica without performing its own compute', async () => {
    const user = await published();
    const compute = vi.spyOn(PublicProfileService, 'computeProfile');
    lock.mockImplementation(async () => {
      await PublicProfile.updateOne({ userId: user._id }, { $set: { 'snapshot.version': 2 } });
      return { executed: false, reason: 'lock_held' };
    });
    const results = await Promise.all(Array.from({ length: 100 }, () => read(user.username)));
    expect(results.every(profile => profile.snapshot.version === 2)).toBe(true);
    expect(compute).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('bounds contended waits and never recomputes unlocked when configured Redis is unavailable', async () => {
    const user = await published();
    vi.stubEnv('REDIS_URL', 'redis://127.0.0.1:1');
    lock.mockResolvedValue({ executed: false, reason: 'lock_held' });
    const compute = vi.spyOn(PublicProfileService, 'computeProfile');
    const start = Date.now();
    await expect(read(user.username)).rejects.toMatchObject({ statusCode: 503 });
    expect(Date.now() - start).toBeLessThan(4500);
    expect(compute).not.toHaveBeenCalled();
    expect(lock).toHaveBeenCalledWith(`devtrack:profile:compute:${user._id}`, expect.any(Function),
      { autoRenew: true, fallbackOnRedisUnavailable: false });
  });

  it('never serves an owner who unpublishes during recomputation', async () => {
    const user = await published();
    vi.spyOn(PublicProfileService, 'computeProfile').mockImplementation(async userId => {
      await PublicProfile.updateOne({ userId }, { $set: { published: false, 'snapshot.version': 2 } });
      return score;
    });
    await expect(read(user.username)).rejects.toThrow('Profile not found');
    expect(await ProfileView.countDocuments({ profileUserId: user._id })).toBe(0);
  });

  it('never locks or creates a profile for an unpublished handle', async () => {
    const user = await published();
    await PublicProfile.updateOne({ userId: user._id }, { $set: { published: false } });
    await expect(read(user.username)).rejects.toThrow('Profile not found');
    expect(lock).not.toHaveBeenCalled();
  });

  it('accepts current/future integer versions and rejects missing or malformed versions', () => {
    for (const snapshot of [undefined, null, { version: 0 }, { version: 1 }, { version: NaN }, { version: 2.5 }]) {
      expect(isCurrentProfileSnapshot(snapshot)).toBe(false);
    }
    expect(isCurrentProfileSnapshot({ version: 2 })).toBe(true);
    expect(isCurrentProfileSnapshot({ version: 3 })).toBe(true);
  });
});
