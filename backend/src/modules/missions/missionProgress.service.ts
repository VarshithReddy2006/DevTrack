// src/modules/missions/missionProgress.service.ts
// Mission progress tracking — updates mission progress and handles completion

import { cacheManager } from '../../shared/cache/cacheManager.js';
import { Types } from 'mongoose';
import { Mission } from '../../db/models/index.js';
import { writeOutboxEvent } from '../../shared/events/outbox.js';
import { logger } from '../../shared/logger.js';
import { eventBus } from '../../shared/sse/index.js';
import { processMissionReward, type XpProcessingResult } from '../xp/processor.js';
import { runInMissionCompletionContext } from './missionCompletionContext.js';

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

    const now = new Date();
    const activeMissions = await Mission.find({
      userId: userObjId,
      category,
      status: { $in: ['pending', 'in_progress'] },
      expiresAt: { $gte: now },
    });

    if (activeMissions.length === 0) return;

    for (const mission of activeMissions) {
      // Check if this activity counts toward this mission
      if (!shouldCountTowardMission(mission, activityType, metadata)) {
        continue;
      }

      const stepNow = new Date();
      // Atomically increment only while non-expired and strictly below targetCount so concurrent updates never overshoot.
      // If already at targetCount (e.g. retry after a rolled-back reward transaction), re-read the active non-expired doc.
      let updated = await Mission.findOneAndUpdate(
        {
          _id: mission._id,
          status: { $in: ['pending', 'in_progress'] },
          expiresAt: { $gte: stepNow },
          $expr: { $lt: ['$currentCount', '$targetCount'] },
        },
        {
          $inc: { currentCount: 1 },
          $set: { status: 'in_progress' },
        },
        { new: true }
      );

      if (!updated) {
        updated = await Mission.findOne({
          _id: mission._id,
          status: { $in: ['pending', 'in_progress'] },
          expiresAt: { $gte: stepNow },
          $expr: { $gte: ['$currentCount', '$targetCount'] },
        });
      }

      // If already completed, expired, or not found, skip
      if (!updated) continue;

      // Atomically commit completion status, XP reward, and outbox event in one transaction.
      // If any step fails, MongoDB rolls back Mission.status to 'in_progress' so retries recover.
      let justCompleted = false;
      let completionReward: XpProcessingResult | null = null;
      let postCommitTasks: Array<() => Promise<void>> = [];

      if (updated.currentCount >= updated.targetCount) {
        try {
          const txResult = await Mission.db.transaction(async (session) => {
            const { value, postCommit } = await runInMissionCompletionContext(session, async () => {
              const completedDoc = await Mission.findOneAndUpdate(
                {
                  _id: mission._id,
                  status: { $in: ['pending', 'in_progress'] },
                  currentCount: { $gte: updated.targetCount },
                },
                {
                  $set: {
                    status: 'completed',
                    completedAt: new Date(),
                  },
                },
                { new: true, session }
              );

              if (!completedDoc) {
                return { completedDoc: null, reward: null as XpProcessingResult | null };
              }

              const reward = await processMissionReward(userId, mission._id.toString());
              if (reward.awarded) {
                await writeOutboxEvent(session, {
                  type: 'mission.completed',
                  aggregateType: 'Mission',
                  aggregateId: mission._id.toString(),
                  userId,
                  payload: {
                    missionId: mission._id.toString(),
                    title: completedDoc.title,
                    xpAwarded: reward.xpAwarded,
                    idempotencyKey: `mission:${mission._id.toString()}:completed`,
                  },
                });
              }

              return { completedDoc, reward };
            });

            return { ...value, postCommit };
          }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });

          if (txResult.completedDoc) {
            justCompleted = true;
            completionReward = txResult.reward;
            postCommitTasks = txResult.postCommit;
          }
        } catch (error) {
          logger.error('[missions] Failed to complete mission atomically', {
            error,
            userId,
            missionId: mission._id.toString(),
          });
        }
      }

      await cacheManager.invalidateDashboard(userId);

      for (const task of postCommitTasks) {
        await task();
      }

      const isCompleted = justCompleted || updated.status === 'completed';

      // Emit SSE event for progress update
      eventBus.emitMissionProgress(userId, {
        missionId: mission._id.toString(),
        title: mission.title,
        currentCount: updated.currentCount,
        targetCount: updated.targetCount,
        completed: isCompleted,
      });

      // Only announce completion after the transaction commits and reward is awarded
      if (justCompleted && completionReward?.awarded) {
        await handleMissionCompletionNotification(userId, mission, completionReward);
      }

      logger.debug('[missions] Mission progress updated', {
        userId,
        missionId: mission._id.toString(),
        title: mission.title,
        currentCount: updated.currentCount,
        targetCount: updated.targetCount,
        completed: isCompleted,
      });
    }
  } catch (error) {
    logger.error('[missions] Failed to update mission progress', { error, userId, activityType });
  }
}

// ─── Mission completion handler ──────────────────────────────────────────────

async function handleMissionCompletionNotification(
  userId: string,
  mission: { _id: Types.ObjectId; title: string },
  result: XpProcessingResult,
): Promise<void> {
  try {
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
    logger.error('[missions] Failed to emit mission completion notification', {
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
