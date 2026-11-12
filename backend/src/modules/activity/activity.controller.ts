// src/modules/activity/activity.controller.ts
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import * as service from './activity.service.js';
import { focusEngine, type FocusHistoryOptions } from './focusEngine.service.js';
import { successResponse, commonErrors, deleteResponse, mutationResponse } from '../../shared/response.js';

/**
 * GET /api/activity — Unified endpoint returning events + heatmap.
 */
export async function getAll(req: AuthenticatedRequest, res: Response): Promise<void> {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const [feedData, heatmapData] = await Promise.all([
    service.getFeed(req.user!.id, { pageSize: 50 }),
    service.getHeatmap(req.user!.id, year),
  ]);

  // Build date→count heatmap map
  const heatmap: Record<string, number> = {};
  for (const day of heatmapData.days) {
    if (day.count > 0) {
      heatmap[day.date] = day.count;
    }
  }

  successResponse(res, {
    events: feedData.activities,
    heatmap,
    summary: heatmapData.summary,
  }, 'Activity retrieved successfully');
}

export async function getHeatmap(req: AuthenticatedRequest, res: Response): Promise<void> {
  const year = parseInt(req.query.year as string) || new Date().getFullYear();
  const data = await service.getHeatmap(req.user!.id, year);
  successResponse(res, data, 'Heatmap retrieved successfully');
}

export async function getFeed(req: AuthenticatedRequest, res: Response): Promise<void> {
  const filters = {
    startDate: req.query.startDate as string,
    endDate: req.query.endDate as string,
    platform: req.query.platform as string,
    type: req.query.type as string,
    tags: req.query.tags ? (req.query.tags as string).split(',') : undefined,
    page: req.query.page ? parseInt(req.query.page as string) : undefined,
    pageSize: req.query.pageSize ? parseInt(req.query.pageSize as string) : undefined,
  };
  const data = await service.getFeed(req.user!.id, filters);
  successResponse(res, data, 'Activity feed retrieved successfully');
}

export async function getActivitiesByDate(req: AuthenticatedRequest, res: Response): Promise<void> {
  const date = req.params.date as string;
  const activities = await service.getActivitiesByDate(req.user!.id, date);
  successResponse(res, activities, 'Activities retrieved successfully');
}

export async function createActivity(req: AuthenticatedRequest, res: Response): Promise<void> {
  const activity = await service.createActivity(req.user!.id, req.body);
  successResponse(res, activity, 'Activity created successfully', 201);
}

export async function deleteActivity(req: AuthenticatedRequest, res: Response): Promise<void> {
  const id = req.params.id as string;
  const deleted = await service.deleteActivity(req.user!.id, id);
  if (!deleted) {
    commonErrors.notFound(res, 'Activity');
    return;
  }
  deleteResponse(res, id, 'Activity deleted successfully');
}

// ─── Focus Session Endpoints ────────────────────────────────────────────────

function parseOptionalInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value, 10);
  return undefined;
}

export async function getFocusHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
  const options: FocusHistoryOptions = {
    status: typeof req.query.status === 'string' ? req.query.status as FocusHistoryOptions['status'] : undefined,
    mode: typeof req.query.mode === 'string' ? req.query.mode : undefined,
    limit: parseOptionalInt(req.query.limit),
    offset: parseOptionalInt(req.query.offset),
  };
  const data = await focusEngine.getUserFocusHistory(req.user!.id, options);
  successResponse(res, data, 'Focus session history retrieved successfully');
}

export async function getFocusSummary(req: AuthenticatedRequest, res: Response): Promise<void> {
  const days = parseOptionalInt(req.query.days) ?? 30;
  const data = await focusEngine.getUserFocusSummary(req.user!.id, days);
  successResponse(res, data, 'Focus session summary retrieved successfully');
}

export async function startFocusSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { duration, mode } = req.body;
  const { unifiedRuntimeStateService } = await import('../runtime-state/unifiedRuntimeState.service.js');
  const state = await unifiedRuntimeStateService.startFocusSession(req.user!.id, duration, mode);
  successResponse(res, state.sessionContext, 'Focus session started');
}

export async function heartbeatFocusSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { unifiedRuntimeStateService } = await import('../runtime-state/unifiedRuntimeState.service.js');
  const state = await unifiedRuntimeStateService.heartbeatFocusSession(req.user!.id);
  successResponse(res, state.sessionContext, 'Focus session heartbeat');
}

export async function pauseFocusSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { unifiedRuntimeStateService } = await import('../runtime-state/unifiedRuntimeState.service.js');
  const state = await unifiedRuntimeStateService.pauseFocusSession(req.user!.id);
  if (!state) { commonErrors.badRequest(res, 'No running focus session'); return; }
  successResponse(res, state.sessionContext, 'Focus session paused');
}

export async function resumeFocusSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { unifiedRuntimeStateService } = await import('../runtime-state/unifiedRuntimeState.service.js');
  const state = await unifiedRuntimeStateService.resumeFocusSession(req.user!.id);
  if (!state) { commonErrors.badRequest(res, 'No paused focus session'); return; }
  successResponse(res, state.sessionContext, 'Focus session resumed');
}

export async function cancelFocusSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { unifiedRuntimeStateService } = await import('../runtime-state/unifiedRuntimeState.service.js');
  const state = await unifiedRuntimeStateService.cancelFocusSession(req.user!.id);
  if (!state) { commonErrors.badRequest(res, 'No active focus session'); return; }
  successResponse(res, state.sessionContext, 'Focus session cancelled');
}

export async function stopFocusSession(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { unifiedRuntimeStateService } = await import('../runtime-state/unifiedRuntimeState.service.js');
  const { state, completed } = await unifiedRuntimeStateService.stopFocusSession(req.user!.id);

  // Nothing was running (never started, or this is a replay of an earlier stop).
  // Succeed so the client can reset its timer, but award nothing.
  if (!completed) {
    successResponse(res, state.sessionContext, 'No running focus session to stop');
    return;
  }

  // One session, one ledger key: a retry or double click collapses in the XP
  // unique index and in the streak log's per-day source list.
  const sourceId = `focus_${completed.sessionId}`;

  // Record as an activity event
  await service.createActivity(req.user!.id, {
    type: 'focus_session',
    title: 'Focus Session Completed',
    description: `Completed a ${state.sessionContext.duration ?? 25} minute focus session.`,
    platform: 'devtrack',
    url: null,
    tags: [],
    metadata: {
      duration: state.sessionContext.duration || 0,
      mode: state.sessionContext.mode || 'pomodoro',
    },
  });

  // Award XP
  const { getXpProcessingQueue } = await import('../../shared/jobs/index.js');
  const queue = getXpProcessingQueue();
  await queue.add('focus-session-completed', {
    userId: req.user!.id,
    sourceType: 'focus_session',
    sourceId,
    metadata: { duration: state.sessionContext.duration },
  });

  // Fetch user's timezone from DB
  const { User } = await import('../../db/models/index.js');
  const userObj = await User.findById(req.user!.id).select('timezone').lean();
  const timezone = (userObj as any)?.timezone || 'UTC';

  // Record streak
  const { recordActivity } = await import('../streak/streak.service.js');
  await recordActivity({
    userId: req.user!.id,
    streakType: 'focus',
    source: sourceId,
    timezone,
  });

  successResponse(res, state.sessionContext, 'Focus session stopped and recorded');
}
