// src/modules/settings/controller.ts
// Hardened settings controller — platform username/handle updates only.
// Internal fields (userId, lastSyncedAt, timestamps) are never client-writable.

import type { Response } from 'express';
import { Types } from 'mongoose';
import { UserSettings } from '../../db/models/userSettings.model.js';
import { ActivityEvent } from '../../db/models/activityEvent.model.js';
import { successResponse, commonErrors } from '../../shared/response.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import { logger } from '../../shared/logger.js';
import { z } from 'zod';
import {
  SYNC_PLATFORMS, applySavedHandle, mirrorHandleToProfile, savedSettingsHandle, submittedSettingsHandle,
} from '../platform-sync/platform-connection.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed platform names — single source of truth. */
const ALLOWED_PLATFORMS = ['github', 'codeforces', 'leetcode', 'codechef'] as const;
type AllowedPlatform = typeof ALLOWED_PLATFORMS[number];

/** Shape a client may send for a single platform. */
interface PlatformUpdateInput {
  username?: string;
  handle?: string;
}

/** Top-level body the client may send to PUT /api/settings. */
interface SettingsUpdateInput {
  platforms?: Partial<Record<AllowedPlatform, PlatformUpdateInput>>;
}

// ---------------------------------------------------------------------------
// Zod validation — strict, no unknown keys
// ---------------------------------------------------------------------------

const platformFieldSchema = z.object({
  username: z.string().max(100).optional(),
  handle:   z.string().max(100).optional(),
}).strict();

const updateSettingsSchema: z.ZodType<SettingsUpdateInput> = z.object({
  platforms: z.object({
    github:     platformFieldSchema.optional(),
    codeforces: platformFieldSchema.optional(),
    leetcode:   platformFieldSchema.optional(),
    codechef:   platformFieldSchema.optional(),
  }).strict().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDotNotationUpdate(
  platforms: NonNullable<SettingsUpdateInput['platforms']>,
): Record<string, string> {
  const update: Record<string, string> = {};

  for (const [platform, fields] of Object.entries(platforms)) {
    if (!fields) continue;
    if (fields.username !== undefined) {
      update[`platforms.${platform}.username`] = fields.username;
    }
    if (fields.handle !== undefined) {
      update[`platforms.${platform}.handle`] = fields.handle;
    }
  }

  return update;
}

function describeChanges(
  platforms: NonNullable<SettingsUpdateInput['platforms']>,
): string {
  const parts: string[] = [];
  for (const [platform, fields] of Object.entries(platforms)) {
    if (!fields) continue;
    const changed = Object.keys(fields).join(', ');
    if (changed) parts.push(`${platform} (${changed})`);
  }
  return parts.length > 0
    ? `Updated platform settings: ${parts.join('; ')}`
    : 'Settings update (no changes)';
}

function mapZodErrors(error: z.ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root';
    if (!details[key]) details[key] = [];
    details[key].push(issue.message);
  }
  return details;
}

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

export async function getSettings(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    commonErrors.unauthorized(res);
    return;
  }

  let settings = await UserSettings.findOne({ userId });

  if (!settings) {
    settings = await UserSettings.create({ userId });
  }

  successResponse(res, settings, 'Settings retrieved successfully');
}

// ---------------------------------------------------------------------------
// PUT /api/settings
// ---------------------------------------------------------------------------

export async function updateSettings(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    commonErrors.unauthorized(res);
    return;
  }

  const parseResult = updateSettingsSchema.safeParse(req.body);
  if (!parseResult.success) {
    commonErrors.validationError(res, mapZodErrors(parseResult.error));
    return;
  }

  const { platforms } = parseResult.data;

  if (!platforms || Object.keys(platforms).length === 0) {
    commonErrors.badRequest(res, 'No valid fields provided for update');
    return;
  }

  const updateData = buildDotNotationUpdate(platforms);
  if (Object.keys(updateData).length === 0) {
    commonErrors.badRequest(res, 'No valid fields provided for update');
    return;
  }

  const previousSettings = await UserSettings.findOne({ userId }).select('platforms').lean();

  const updatedSettings = await UserSettings.findOneAndUpdate(
    { userId },
    { $set: updateData },
    { upsert: true, new: true, runValidators: true },
  );

  // Sync reads ConnectedPlatform, so a saved or cleared handle has to reach it.
  for (const platform of SYNC_PLATFORMS) {
    const sent = platforms[platform];
    if (!sent) continue;
    const saved = previousSettings?.platforms?.[platform];
    const next = submittedSettingsHandle(platform, sent, saved);
    if (next === undefined) continue;
    if (await applySavedHandle(userId, platform, next, savedSettingsHandle(platform, saved))) {
      await mirrorHandleToProfile(userId, platform, next);
    }
  }

  const activityDescription = describeChanges(platforms);
  ActivityEvent.create({
    userId: new Types.ObjectId(userId),
    type: 'settings_updated',
    title: 'Settings Updated',
    description: activityDescription,
    platform: 'devtrack',
    url: null,
    tags: ['settings'],
    metadata: {},
    occurredAt: new Date(),
  }).catch((err: unknown) => {
    logger.error('Failed to log settings activity', err);
  });

  successResponse(res, updatedSettings, 'Settings updated successfully');
}
