// src/modules/missions/missionProgress.service.ts
// Mission progress tracking — updates mission progress and handles completion

import { cacheManager } from '../../shared/cache/cacheManager.js';
import { Types } from 'mongoose';
import { Mission } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { eventBus } from '../../shared/sse/index.js';
import { processMissionReward } from '../xp/processor.js';

export type ActivityType = 'dsa_solve' | 'dsa_contest' | 'sync' | 'streak_day' | 'project_task';

// ─── Mission progress updater ────────────────────────────────────────────────

export async function updateMissionProgress(
  userId: string,
  activityType: ActivityType,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    const userObjId = new Types.ObjectId(userId);

    // Find active missions matching this activity type
    const category = mapActivityToCategory(activityType);
    if (!category) return;

    const activeMissions = await Mission.find({
      userId: userObjId,
      category,
      status: { $in: ['pending', 'in_progress'] },
      expiresAt: { $gte: new Date() },
    });

    if (activeMissions.length === 0) return;

    for (const mission of activeMissions) {
      // Check if this activity counts toward this mission
      if (!shouldCountTowardMission(mission, activityType, metadata)) {
        continue;
      }

      // Increment progress
      const newCount = mission.currentCount + 1;
      const isCompleted = newCount >= mission.targetCount;

      // Update mission
      await Mission.findByIdAndUpdate(mission._id, {
        $set: {
          currentCount: newCount,
          status: isCompleted ? 'completed' : 'in_progress',
          completedAt: isCompleted ? new Date() : null,
        },
      });

      await cacheManager.invalidateDashboard(userId);

      // Emit SSE event for progress update
      eventBus.emitMissionProgress(userId, {
        missionId: mission._id.toString(),
        title: mission.title,
        currentCount: newCount,
        targetCount: mission.targetCount,
        completed: isCompleted,
      });

      // If completed, award XP and emit completion event
      if (isCompleted) {
        await handleMissionCompletion(userId, mission);
      }

      logger.debug('[missions] Mission progress updated', {
        userId,
        missionId: mission._id.toString(),
        title: mission.title,
        currentCount: newCount,
        targetCount: mission.targetCount,
        completed: isCompleted,
      });
    }
  } catch (error) {
    logger.error('[missions] Failed to update mission progress', { error, userId, activityType });
  }
}

// ─── Mission completion handler ──────────────────────────────────────────────

async function handleMissionCompletion(userId: string, mission: { _id: Types.ObjectId; title: string }): Promise<void> {
  try {
    const result = await processMissionReward(userId, mission._id.toString());
    if (!result.awarded) return;

    // Emit SSE notification for mission completion
    eventBus.emitNotificationCreated(
      userId,
      `mission_completion_${mission._id.toString()}`,
      'mission_completed',
      'Mission Complete! 🎉',
      `${mission.title} — +${result.xpAwarded} XP`,
      'celebration',
      'medium'
    );

    logger.info('[missions] Mission completed', {
      userId,
      missionId: mission._id.toString(),
      title: mission.title,
      xpReward: result.xpAwarded,
    });
  } catch (error) {
    logger.error('[missions] Failed to handle mission completion', {
      error,
      userId,
      missionId: mission._id.toString(),
    });
  }
}

// ─── Helper functions ────────────────────────────────────────────────────────

function mapActivityToCategory(activityType: ActivityType): 'dsa' | 'project' | 'consistency' | null {
  switch (activityType) {
    case 'dsa_solve':
    case 'dsa_contest':
      return 'dsa';
    case 'project_task':
      return 'project';
    case 'streak_day':
    case 'sync':
      return 'consistency';
    default:
      return null;
  }
}

function shouldCountTowardMission(
  mission: any,
  activityType: ActivityType,
  metadata?: Record<string, unknown>
): boolean {
  // For DSA missions, check if difficulty matches (if specified in mission title)
  if (activityType === 'dsa_solve' && mission.category === 'dsa') {
    const missionTitle = mission.title.toLowerCase();

    // Use the same contest marker as the dsa_contest branch below.
    if (missionTitle.includes('contest')) return false;

    // If mission specifies difficulty, check metadata
    if (missionTitle.includes('easy') && metadata?.difficulty !== 'easy') return false;
    if (missionTitle.includes('medium') && metadata?.difficulty !== 'medium') return false;
    if (missionTitle.includes('hard') && metadata?.difficulty !== 'hard') return false;

    return true;
  }

  // For contest missions
  if (activityType === 'dsa_contest' && mission.category === 'dsa') {
    return mission.title.toLowerCase().includes('contest');
  }

  // For streak missions
  if (activityType === 'streak_day' && mission.category === 'consistency') {
    return mission.title.toLowerCase().includes('streak');
  }

  // For project missions
  if (activityType === 'project_task' && mission.category === 'project') {
    return true;
  }

  return false;
}

// ─── Public API for getting user missions ────────────────────────────────────

export type MissionCategory = 'dsa' | 'project' | 'consistency' | 'learning';
export type MissionHistoryStatus = 'completed' | 'expired' | 'all';

export const MISSION_CATEGORIES: readonly MissionCategory[] = ['dsa', 'project', 'consistency', 'learning'];
export const MISSION_HISTORY_STATUSES: readonly MissionHistoryStatus[] = ['completed', 'expired', 'all'];
const TERMINAL_HISTORY_STATUSES = new Set<string>(['completed', 'expired']);

export interface MissionHistoryOptions {
  status?: MissionHistoryStatus;
  category?: MissionCategory;
  limit?: number;
  offset?: number;
}

export interface MissionHistoryResult {
  missions: any[];
  total: number;
  limit: number;
  offset: number;
}

function serializeMission(m: any, includeCompletedAt = false) {
  const progressPercent = m.targetCount > 0
    ? Math.min(100, Math.round((m.currentCount / m.targetCount) * 100))
    : 0;
  return {
    id: m._id.toString(),
    title: m.title,
    description: m.description,
    type: m.type,
    category: m.category,
    status: m.status,
    currentCount: m.currentCount,
    targetCount: m.targetCount,
    xpReward: m.xpReward,
    progressPercent,
    ...(includeCompletedAt ? { completedAt: m.completedAt } : {}),
    expiresAt: m.expiresAt,
    createdAt: m.createdAt,
  };
}

export async function getUserMissions(userId: string, category?: string): Promise<any[]> {
  const userObjId = new Types.ObjectId(userId);

  const query: Record<string, unknown> = {
    userId: userObjId,
    status: { $in: ['pending', 'in_progress'] },
    expiresAt: { $gte: new Date() },
  };

  if (category) {
    query.category = category;
  }

  // Get active missions (not expired, not completed)
  const missions = await Mission.find(query)
    .sort({ type: 1, createdAt: -1 }) // Daily first, then weekly
    .lean();

  return missions.map((m) => serializeMission(m));
}

export async function getUserMissionHistory(
  userId: string,
  options: MissionHistoryOptions = {}
): Promise<MissionHistoryResult> {
  const userObjId = new Types.ObjectId(userId);
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.min(100, Math.max(1, Math.trunc(options.limit)))
    : 20;
  const offset = typeof options.offset === 'number' && Number.isFinite(options.offset)
    ? Math.max(0, Math.trunc(options.offset))
    : 0;

  const query: Record<string, unknown> = {
    userId: userObjId,
  };

  if (options.status && TERMINAL_HISTORY_STATUSES.has(options.status)) {
    query.status = options.status;
  } else {
    query.status = { $in: ['completed', 'expired'] };
  }

  if (options.category) {
    query.category = options.category;
  }

  const [total, missions] = await Promise.all([
    Mission.countDocuments(query),
    Mission.find(query)
      .sort({ completedAt: -1, expiresAt: -1, createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
  ]);

  return {
    missions: missions.map((m) => serializeMission(m, true)),
    total,
    limit,
    offset,
  };
}
