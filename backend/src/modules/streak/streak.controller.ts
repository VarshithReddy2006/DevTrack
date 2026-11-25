// src/modules/streak/streak.controller.ts — Streak API controller
import { getStreakStatus, recordActivity, activateStreakFreeze, getStreakHistory } from './streak.service.js';
import type { StreakType } from '../../db/models/index.js';
import { ApiResponse } from '../../shared/response.js';
import { withAuth } from '../../shared/controllerUtils.js';

const VALID_STREAK_TYPES = ['dsa', 'github', 'unified', 'focus', 'revision'] as const;

export const streakController = {
  getStreak: withAuth('[streak]', 'get streak status', async (userId, _req, res) => {
    const status = await getStreakStatus(userId);
    ApiResponse.success(res, status);
  }),

  getStreakByType: withAuth('[streak]', 'get streak by type', async (userId, req, res) => {
    const { type } = req.params;

    if (!VALID_STREAK_TYPES.includes(type as StreakType)) {
      ApiResponse.badRequest(res, 'Invalid streak type. Use: dsa, github, unified, focus, or revision');
      return;
    }

    const status = await getStreakStatus(userId, type as StreakType);
    ApiResponse.success(res, status);
  }),

  recordActivity: withAuth('[streak]', 'record activity', async (userId, req, res) => {
    const { streakType, source, activityDate, timezone, metadata } = req.body as {
      streakType?: string;
      source?: string;
      activityDate?: string;
      timezone?: string;
      metadata?: Record<string, unknown>;
    };

    if (!streakType || !source) {
      ApiResponse.badRequest(res, 'streakType and source are required');
      return;
    }

    if (!VALID_STREAK_TYPES.includes(streakType as StreakType)) {
      ApiResponse.badRequest(res, 'Invalid streak type');
      return;
    }

    await recordActivity({
      userId,
      streakType: streakType as StreakType,
      source,
      activityDate: activityDate ? new Date(activityDate) : undefined,
      timezone,
      metadata,
    });
    ApiResponse.success(res, { recorded: true });
  }),

  activateFreeze: withAuth('[streak]', 'activate streak freeze', async (userId, _req, res) => {
    await activateStreakFreeze(userId);
    ApiResponse.success(res, { freezeActivated: true });
  }),

  getHistory: withAuth('[streak]', 'get streak history', async (userId, _req, res) => {
    const history = await getStreakHistory(userId);
    ApiResponse.success(res, history);
  }),
};