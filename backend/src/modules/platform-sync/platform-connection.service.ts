// src/modules/platform-sync/platform-connection.service.ts
// Single place where a saved platform handle becomes a sync connection or stops being one.
// Used by the Settings form, the Profile form and the explicit connect endpoint.

import { Types } from 'mongoose';
import {
  ConnectedPlatform, PlatformStats, DsaTopicProgress, UserProfile, UserSettings, type IConnectedPlatform,
} from '../../db/models/index.js';
import { PLATFORMS } from '../../config/constants.js';
import { cacheManager } from '../../shared/cache/cacheManager.js';
import { invalidateCacheTag, portfolioTag } from '../../shared/redis/cacheTags.js';
import { PLATFORM_TOPIC_NAMES } from '../dsa/dsa.constants.js';

export const SYNC_PLATFORMS = ['github', 'codeforces', 'leetcode', 'codechef'] as const;
export type SyncPlatformName = typeof SYNC_PLATFORMS[number];

/** The UserSettings field the Settings screen edits first, then the legacy alternative. */
const SETTINGS_FIELDS = {
  github: ['username', 'handle'],
  codeforces: ['handle', 'username'],
  leetcode: ['username', 'handle'],
  codechef: ['username', 'handle'],
} as const;

type SettingsHandle = { username?: string | null; handle?: string | null };

/** Accepts a bare handle or a pasted profile URL. An empty result means no handle. */
export function normalizeHandle(value: string | null | undefined): string {
  const path = (value ?? '').trim().split(/[?#]/)[0];
  return path.split('/').filter(Boolean).pop()?.trim() ?? '';
}

/** The handle a settings document currently holds for one platform. */
export function savedSettingsHandle(platformName: SyncPlatformName, saved: SettingsHandle | undefined): string {
  const [primary, fallback] = SETTINGS_FIELDS[platformName];
  return saved?.[primary] || saved?.[fallback] || '';
}

/** The handle a settings update asks for, given what was saved before it. */
export function submittedSettingsHandle(
  platformName: SyncPlatformName, sent: SettingsHandle, saved: SettingsHandle | undefined,
): string | undefined {
  const [primary, fallback] = SETTINGS_FIELDS[platformName];
  if (sent[primary] !== undefined) return sent[primary] || sent[fallback] || '';
  if (sent[fallback] !== undefined) return saved?.[primary] || sent[fallback] || '';
  return undefined;
}

async function refreshViews(userId: string): Promise<void> {
  await cacheManager.invalidateDashboard(userId);
  await invalidateCacheTag(portfolioTag(userId));
}

/** Removes the numbers sync stored for the account that was connected before. */
async function clearSyncedStats(userId: Types.ObjectId, platformName: SyncPlatformName): Promise<void> {
  await PlatformStats.deleteOne({ userId, platformName });
  if (platformName !== 'github') {
    await DsaTopicProgress.deleteOne({ userId, topicName: PLATFORM_TOPIC_NAMES[platformName] });
  }
}

export async function connectPlatformAccount(
  userId: string, platformName: SyncPlatformName, username: string,
): Promise<IConnectedPlatform> {
  const owner = new Types.ObjectId(userId);
  const handle = normalizeHandle(username);
  const [current, stats] = await Promise.all([
    ConnectedPlatform.findOne({ userId: owner, platformName }).lean(),
    PlatformStats.findOne({ userId: owner, platformName }).select('username').lean(),
  ]);
  // Handles on all four providers are case-insensitive.
  const otherAccount = [current?.username, stats?.username]
    .some(name => name !== undefined && name.toLowerCase() !== handle.toLowerCase());

  const platform = await ConnectedPlatform.findOneAndUpdate(
    { userId: owner, platformName },
    {
      $set: {
        username: handle,
        profileUrl: PLATFORMS[platformName.toUpperCase() as keyof typeof PLATFORMS].profileUrl(handle),
        isConnected: true,
        syncStatus: 'idle',
        syncError: null,
        ...(otherAccount ? { lastSyncedAt: null } : {}),
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
  if (otherAccount) await clearSyncedStats(owner, platformName);

  await refreshViews(userId);
  return platform;
}

export async function disconnectPlatformAccount(userId: string, platformName: SyncPlatformName): Promise<void> {
  const owner = new Types.ObjectId(userId);
  await ConnectedPlatform.updateOne(
    { userId: owner, platformName },
    { $set: { isConnected: false, syncStatus: 'idle', syncError: null, lastSyncedAt: null } },
  );
  await clearSyncedStats(owner, platformName);
  await refreshViews(userId);
}

/**
 * Applies a handle saved on a form. A new or not yet connected handle connects, emptying a
 * previously saved one disconnects. Returns false when nothing had to change, so saving a form
 * again keeps the sync state, and an empty field that was always empty disconnects nothing.
 */
export async function applySavedHandle(
  userId: string, platformName: SyncPlatformName, next: string | null | undefined, previous: string | null | undefined,
): Promise<boolean> {
  const handle = normalizeHandle(next);
  const before = normalizeHandle(previous);
  if (!handle) {
    if (!before) return false;
    await disconnectPlatformAccount(userId, platformName);
    return true;
  }
  if (handle === before && await ConnectedPlatform.exists({ userId, platformName, isConnected: true })) return false;
  await connectPlatformAccount(userId, platformName, handle);
  return true;
}

/** Keeps the Profile form showing the handle that was saved elsewhere. */
export async function mirrorHandleToProfile(userId: string, platformName: SyncPlatformName, value: string): Promise<void> {
  const handle = normalizeHandle(value);
  const profile = await UserProfile.findOne({ userId }).select('socialLinks').lean();
  // A stored profile URL that already points at this handle is left as the user wrote it.
  if (normalizeHandle(profile?.socialLinks?.[platformName]) === handle) return;
  await UserProfile.updateOne(
    { userId }, { $set: { [`socialLinks.${platformName}`]: handle || null } }, { upsert: true },
  );
}

/** Keeps the Settings form showing the handle that was saved elsewhere. */
export async function mirrorHandleToSettings(userId: string, platformName: SyncPlatformName, value: string): Promise<void> {
  const [primary, fallback] = SETTINGS_FIELDS[platformName];
  await UserSettings.updateOne(
    { userId },
    { $set: { [`platforms.${platformName}.${primary}`]: normalizeHandle(value), [`platforms.${platformName}.${fallback}`]: '' } },
    { upsert: true },
  );
}
