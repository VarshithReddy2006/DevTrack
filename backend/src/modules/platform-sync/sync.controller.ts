// src/modules/platform-sync/sync.controller.ts
// ============================================================================
// Sync Controller — Platform Sync Endpoints
// ============================================================================
// Handles HTTP layer for platform sync operations. All platform data fetching,
// normalization, and MongoDB persistence is delegated to sync.service.ts.
// Responses never expose raw scraped data — only normalized stats.
// ============================================================================

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import * as syncService from './sync.service.js';
import { successResponse, commonErrors } from '../../shared/response.js';
import { logger } from '../../shared/logger.js';
import { UserSettings, ConnectedPlatform, PlatformStats } from '../../db/models/index.js';
import { Types } from 'mongoose';
import { createActivity } from '../activity/activity.service.js';
import { syncState } from '../../shared/syncState.js';

// Platforms that support sync
const SUPPORTED_PLATFORMS = ['leetcode', 'codeforces', 'codechef', 'github'];

/**
 * POST /platforms/sync-all
 * Trigger sync for ALL connected platforms of the authenticated user.
 * Returns per-platform success/error results (no raw data).
 */
export async function syncAll(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  logger.info(`Sync-all triggered for user ${userId}`);

  try {
    const results = await syncService.syncAllPlatforms(userId);

    // Strip any raw data from the response — return only normalized stats
    const sanitized = results.map((r) => ({
      platform: r.platform,
      success: r.success,
      stats: r.stats
        ? {
            totalSolved: r.stats.totalSolved,
            easySolved: r.stats.easySolved,
            mediumSolved: r.stats.mediumSolved,
            hardSolved: r.stats.hardSolved,
            rating: r.stats.rating ?? null,
            rank: r.stats.rank ?? null,
            totalContests: r.stats.totalContests ?? 0,
          }
        : null,
      error: r.error ?? null,
    }));

    const allSucceeded = sanitized.length > 0 && sanitized.every((r) => r.success);
    const someSucceeded = sanitized.some((r) => r.success);

    if (someSucceeded) {
      try {
        const { ReadinessAggregationService } = await import('../readiness/services/ReadinessAggregationService.js');
        await ReadinessAggregationService.refreshFragments(userId, ['dsa']);
      } catch (err) {
        logger.warn('Non-fatal: readiness DSA refresh after sync-all failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const message = sanitized.length === 0
      ? 'No connected platforms to sync'
      : allSucceeded
        ? `All ${sanitized.length} platform(s) synced successfully`
        : someSucceeded
          ? `Partial sync: ${sanitized.filter((r) => r.success).length}/${sanitized.length} succeeded`
          : 'All platform syncs failed';

    successResponse(res, { results: sanitized, syncedAt: new Date().toISOString() }, message);
  } catch (error) {
    logger.error('Sync-all fatal error', error);
    commonErrors.internalError(res, 'Platform sync failed unexpectedly');
  }
}

/**
 * POST /platforms/sync/:platformName
 * Trigger sync for a SINGLE platform.
 * Validates platformName before executing.
 */
export async function syncSingle(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const platformName = req.params.platformName as string;

  if (!SUPPORTED_PLATFORMS.includes(platformName)) {
    commonErrors.badRequest(
      res,
      `Platform "${platformName}" is not supported. Supported: ${SUPPORTED_PLATFORMS.join(', ')}`
    );
    return;
  }

  logger.info(`Sync triggered for user ${userId}, platform: ${platformName}`);

  try {
    const result = await syncService.syncPlatform(userId, platformName);

    const sanitized = {
      platform: result.platform,
      success: result.success,
      stats: result.stats
        ? {
            totalSolved: result.stats.totalSolved,
            easySolved: result.stats.easySolved,
            mediumSolved: result.stats.mediumSolved,
            hardSolved: result.stats.hardSolved,
            rating: result.stats.rating ?? null,
            rank: result.stats.rank ?? null,
            totalContests: result.stats.totalContests ?? 0,
          }
        : null,
      error: result.error ?? null,
      syncedAt: new Date().toISOString(),
    };

    if (result.success) {
      successResponse(res, sanitized, `${platformName} synced successfully`);
    } else {
      // Return 200 with success:false rather than 500, because the sync was
      // attempted and the error is user-facing (e.g. "user not found")
      successResponse(res, sanitized, `${platformName} sync failed: ${result.error}`);
    }
  } catch (error) {
    logger.error(`Sync failed for ${platformName}`, error);
    commonErrors.internalError(res, `Sync failed for ${platformName}`);
  }
}

/**
 * GET /platforms/sync-scheduler-status
 * Returns the global scheduler state (read-only snapshot).
 * Lightweight — no database queries, just the in-memory singleton.
 */
export async function getSchedulerStatus(
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> {
  const snapshot = syncState.getSnapshot();
  logger.debug('[controller] Scheduler status requested', {
    status: snapshot.status,
    lastSyncStatus: snapshot.lastSyncStatus,
    totalSyncs: snapshot.totalSyncs,
  });
  successResponse(res, snapshot, 'Scheduler status retrieved');
}

/**
 * GET /platforms/sync-status
 * Returns the last sync status for each connected platform.
 * Useful for the frontend to show sync indicators without triggering a sync.
 */
export async function getSyncStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;

  try {
    const statuses = await syncService.getSyncStatus(userId);
    successResponse(res, statuses, 'Sync status retrieved');
  } catch (error) {
    logger.error('Failed to retrieve sync status', error);
    commonErrors.internalError(res, 'Failed to retrieve sync status');
  }
}

// ---------------------------------------------------------------------------
// POST /api/sync/github — Dedicated GitHub sync from UserSettings
// ---------------------------------------------------------------------------

/**
 * Reads github.username from UserSettings, ensures a ConnectedPlatform record
 * exists, delegates to the sync pipeline, then updates lastSyncedAt on the
 * settings document and logs an activity event.
 */
export async function syncGithub(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    commonErrors.unauthorized(res);
    return;
  }

  try {
    // 1. Read GitHub username from UserSettings
    const settings = await UserSettings.findOne({ userId });
    const githubUsername = settings?.platforms?.github?.username;

    if (!githubUsername) {
      commonErrors.badRequest(res, 'GitHub username not configured. Set it in Settings → Integrations first.');
      return;
    }

    logger.info(`GitHub sync triggered for user ${userId}, github: ${githubUsername}`);

    // 2. Ensure ConnectedPlatform record exists (auto-create from settings)
    await ConnectedPlatform.findOneAndUpdate(
      { userId: new Types.ObjectId(userId), platformName: 'github' },
      {
        username: githubUsername,
        profileUrl: `https://github.com/${githubUsername}`,
        isConnected: true,
      },
      { upsert: true, new: true },
    );

    // 3. Delegate to existing sync pipeline
    const result = await syncService.syncPlatform(userId, 'github');

    // 4. Update lastSyncedAt on UserSettings
    if (result.success) {
      await UserSettings.findOneAndUpdate(
        { userId },
        { $set: { 'platforms.github.lastSyncedAt': new Date() } },
      );

      // 5. Read persisted stats for activity metadata
      const persistedStats = await PlatformStats.findOne({
        userId: new Types.ObjectId(userId),
        platformName: 'github',
      }).lean();

      const publicRepos = (persistedStats?.rawData?.public_repos as number) ?? result.stats?.totalSolved ?? 0;
      const followers = (persistedStats?.rawData?.followers as number) ?? 0;

      // 6. Activity log
      createActivity(userId, {
        type: 'settings_updated',
        title: 'GitHub Synced',
        description: `Synced GitHub data for @${githubUsername}`,
        platform: 'github',
        url: `https://github.com/${githubUsername}`,
        tags: ['sync', 'github'],
        metadata: {
          public_repos: publicRepos,
          followers,
        },
      }).catch((err: unknown) => {
        logger.warn('Failed to log GitHub sync activity', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // 6. Response
    const lastSyncedAt = new Date().toISOString();

    successResponse(
      res,
      {
        platform: 'github',
        success: result.success,
        stats: result.stats
          ? {
              totalSolved: result.stats.totalSolved,
              easySolved: result.stats.easySolved,
              mediumSolved: result.stats.mediumSolved,
              hardSolved: result.stats.hardSolved,
              rating: result.stats.rating ?? null,
              rank: result.stats.rank ?? null,
              totalContests: result.stats.totalContests ?? 0,
            }
          : null,
        error: result.error ?? null,
        lastSyncedAt,
      },
      result.success
        ? `GitHub synced successfully for @${githubUsername}`
        : `GitHub sync failed: ${result.error}`,
    );
  } catch (error) {
    logger.error('GitHub sync fatal error', error);
    commonErrors.internalError(res, 'GitHub sync failed unexpectedly');
  }
}
