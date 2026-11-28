import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import { ConnectedPlatform, DsaTopicProgress, PlatformStats, User, UserProfile, UserSettings } from '../../../db/models/index.js';
import { updateSettings } from '../../../modules/settings/controller.js';
import { connectPlatform, updateProfile } from '../../../modules/profile/profile.service.js';
import { syncAllPlatforms, syncPlatform } from '../../../modules/platform-sync/sync.service.js';
import type { AuthenticatedRequest } from '../../../middleware/auth.js';

vi.mock('../../../shared/sse/index.js', () => ({ eventBus: { emitSyncStarted: vi.fn(), emitSyncCompleted: vi.fn(), emitSyncFailed: vi.fn() } }));
vi.mock('../../../shared/redis/syncLock.service.js', () => ({
  acquireSyncLockWithRetry: vi.fn().mockResolvedValue(true), releaseSyncLock: vi.fn(),
}));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getReadinessDsaQueue: () => ({ add: vi.fn() }) }));

let userId: string;
beforeEach(async () => {
  const user = await User.create({ clerkId: 'synthetic-connect', username: 'connector', email: 'connect@example.test', displayName: 'Connector' });
  userId = user._id.toString();
});
afterEach(() => { vi.unstubAllGlobals(); });

async function saveSettings(platforms: Record<string, { username?: string; handle?: string }>) {
  let status = 200;
  const res = { status: (code: number) => { status = code; return res; }, json: () => res };
  await updateSettings({ user: { id: userId }, body: { platforms } } as unknown as AuthenticatedRequest, res as unknown as Response);
  expect(status).toBe(200);
}

const connection = (platformName: string) => ConnectedPlatform.findOne({ userId, platformName }).lean();
const links = async () => (await UserProfile.findOne({ userId }).lean())?.socialLinks;
const saved = async () => (await UserSettings.findOne({ userId }).lean())?.platforms;

/** A platform that has already synced once. */
async function synced(platformName: 'leetcode' | 'codeforces' | 'github', username: string) {
  await connectPlatform(userId, platformName, username);
  await ConnectedPlatform.updateOne({ userId, platformName }, { syncStatus: 'success', lastSyncedAt: new Date() });
  await PlatformStats.create({ userId, platformName, username, totalSolved: 300 });
  if (platformName === 'leetcode') await DsaTopicProgress.create({ userId, topicName: 'LeetCode Problems', solvedCount: 300 });
}

describe('handles saved in Settings', () => {
  it('connects every platform so sync-all picks them up, and fills the profile', async () => {
    await saveSettings({ github: { username: 'gh' }, codeforces: { handle: 'cf' }, leetcode: { username: 'lc' }, codechef: { username: 'cc' } });
    const connected = await ConnectedPlatform.find({ userId, isConnected: true }).sort({ platformName: 1 }).lean();
    expect(connected.map(p => [p.platformName, p.username])).toEqual([['codechef', 'cc'], ['codeforces', 'cf'], ['github', 'gh'], ['leetcode', 'lc']]);
    expect(connected[1].profileUrl).toBe('https://codeforces.com/profile/cf');
    expect(await links()).toMatchObject({ github: 'gh', codeforces: 'cf', leetcode: 'lc', codechef: 'cc' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect((await syncAllPlatforms(userId)).map(r => r.platform).sort()).toEqual(['codechef', 'codeforces', 'github', 'leetcode']);
  });

  it('disconnects a cleared handle and removes only its synced numbers', async () => {
    await synced('leetcode', 'someone_else');
    await synced('github', 'mine');
    await saveSettings({ leetcode: { username: '' } });
    expect(await connection('leetcode')).toMatchObject({ isConnected: false, lastSyncedAt: null, syncStatus: 'idle' });
    expect(await PlatformStats.countDocuments({ userId, platformName: 'leetcode' })).toBe(0);
    expect(await DsaTopicProgress.countDocuments({ userId })).toBe(0);
    expect((await links())?.leetcode).toBeNull();
    expect(await connection('github')).toMatchObject({ isConnected: true, syncStatus: 'success' });
    expect(await PlatformStats.countDocuments({ userId, platformName: 'github' })).toBe(1);
    expect(await syncPlatform(userId, 'leetcode')).toMatchObject({ success: false, error: 'Platform not connected' });
  });

  it('clears a Codeforces handle that was saved through the Settings field', async () => {
    await saveSettings({ codeforces: { handle: 'cf' } });
    await saveSettings({ codeforces: { handle: '' } });
    expect(await connection('codeforces')).toMatchObject({ isConnected: false });
    expect((await links())?.codeforces).toBeNull();
  });

  it('keeps sync state when the same handle is saved again', async () => {
    await synced('leetcode', 'mine');
    await saveSettings({ leetcode: { username: 'mine' } });
    expect(await connection('leetcode')).toMatchObject({ syncStatus: 'success', lastSyncedAt: expect.any(Date) });
    expect(await PlatformStats.countDocuments({ userId })).toBe(1);
  });

  it('drops the old numbers when the handle changes, but not for a change of letter case', async () => {
    await synced('leetcode', 'mine');
    await saveSettings({ leetcode: { username: 'MINE' } });
    expect(await PlatformStats.countDocuments({ userId })).toBe(1);
    await saveSettings({ leetcode: { username: 'other' } });
    expect(await connection('leetcode')).toMatchObject({ username: 'other', isConnected: true, lastSyncedAt: null, syncStatus: 'idle' });
    expect(await PlatformStats.countDocuments({ userId })).toBe(0);
    expect(await DsaTopicProgress.countDocuments({ userId })).toBe(0);
  });
});

describe('handles saved on the Profile', () => {
  // The Profile form always sends every link, with null for the empty ones.
  const form = (socialLinks: Record<string, string | null>) => updateProfile(userId, {
    socialLinks: { github: null, linkedin: null, twitter: null, portfolio: null, leetcode: null, codeforces: null, codechef: null, ...socialLinks },
  });

  it('connects a new handle, fills Settings, and disconnects it when cleared', async () => {
    await form({ codeforces: 'tourist' });
    expect(await connection('codeforces')).toMatchObject({ username: 'tourist', isConnected: true });
    expect(await saved()).toMatchObject({ codeforces: { handle: 'tourist' } });
    await PlatformStats.create({ userId, platformName: 'codeforces', username: 'tourist', totalSolved: 300 });
    await form({});
    expect(await connection('codeforces')).toMatchObject({ isConnected: false });
    expect(await PlatformStats.countDocuments({ userId })).toBe(0);
    expect(await saved()).toMatchObject({ codeforces: { handle: '' } });
  });

  it('connects the name inside a GitHub URL and leaves the URL on the profile', async () => {
    await form({ github: 'https://github.com/octocat/' });
    expect(await connection('github')).toMatchObject({ username: 'octocat', profileUrl: 'https://github.com/octocat' });
    expect((await links())?.github).toBe('https://github.com/octocat/');
  });

  it('keeps sync state when the profile is saved again unchanged', async () => {
    await synced('leetcode', 'mine');
    await form({ leetcode: 'mine' });
    expect(await connection('leetcode')).toMatchObject({ syncStatus: 'success', lastSyncedAt: expect.any(Date) });
  });

  it('connects a stored handle that never got a connection', async () => {
    await UserProfile.create({ userId, socialLinks: { codechef: 'chef' } });
    await form({ codechef: 'chef' });
    expect(await connection('codechef')).toMatchObject({ username: 'chef', isConnected: true });
  });

  it('does not disconnect through a field that was already empty, or through an update without links', async () => {
    await ConnectedPlatform.create({ userId, platformName: 'github', username: 'mine', profileUrl: 'https://github.com/mine' });
    await form({});
    await updateProfile(userId, { bio: 'hello' });
    expect(await connection('github')).toMatchObject({ isConnected: true });
  });
});

it('removes the old numbers when the connect endpoint switches accounts', async () => {
  await synced('leetcode', 'someone_else');
  await connectPlatform(userId, 'leetcode', 'mine');
  expect(await PlatformStats.countDocuments({ userId })).toBe(0);
  expect(await saved()).toMatchObject({ leetcode: { username: 'mine' } });
});

it.each([
  ['cleared', ''],
  ['replaced', 'second'],
])('does not store a running sync for a handle that was %s meanwhile', async (_name, next) => {
  await saveSettings({ codechef: { username: 'first' } });
  vi.stubGlobal('fetch', vi.fn(async () => {
    await saveSettings({ codechef: { username: next } });
    return new Response('<h3>Total Problems Solved: 40</h3>');
  }));
  expect(await syncPlatform(userId, 'codechef')).toMatchObject({ success: false, error: expect.stringContaining('changed during sync') });
  expect(await PlatformStats.countDocuments({ userId })).toBe(0);
  expect(await connection('codechef')).toMatchObject({ isConnected: next !== '', syncStatus: 'idle', syncError: null });
});
