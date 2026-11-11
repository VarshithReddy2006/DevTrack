// src/modules/missions/missionGenerator.service.ts
// Mission auto-generation service — generates daily and weekly missions for active users

import { cacheManager } from '../../shared/cache/cacheManager.js';
import { Types } from 'mongoose';
import { Mission, UserXp, User, type IMission } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { eventBus } from '../../shared/sse/index.js';

interface MissionTemplate {
  title: string;
  description: string;
  type: 'daily' | 'weekly';
  category: 'dsa' | 'project' | 'learning' | 'consistency';
  targetCount: number;
  xpReward: number;
  expiresInHours: number;
}

// ─── Mission generation logic ────────────────────────────────────────────────

export async function generateDailyMissions(): Promise<void> {
  logger.info('[missions] Starting daily mission generation');

  try {
    // Get active users (active within last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const activeUsers = await User.find({
      lastActiveAt: { $gte: sevenDaysAgo },
    }).select('_id');

    logger.info(`[missions] Found ${activeUsers.length} active users for daily missions`);

    let generated = 0;
    let skipped = 0;

    for (const user of activeUsers) {
      const userId = user._id.toString();

      // Expire old daily missions
      await Mission.updateMany(
        {
          userId: user._id,
          type: 'daily',
          status: { $in: ['pending', 'in_progress'] },
          expiresAt: { $lt: new Date() },
        },
        { $set: { status: 'expired' } }
      );

      await cacheManager.invalidateDashboard(userId);

      // Check if user already has active daily missions
      const existingDailyMissions = await Mission.countDocuments({
        userId: user._id,
        type: 'daily',
        status: { $in: ['pending', 'in_progress'] },
        expiresAt: { $gte: new Date() },
      });

      if (existingDailyMissions > 0) {
        skipped++;
        continue;
      }

      // Get user's stats to calibrate difficulty
      const userXp = await UserXp.findOne({ userId: user._id });
      const avgProblemsPerDay = calculateAvgProblemsPerDay(userXp);
      const userLevel = userXp?.currentLevel ?? 1;

      // Generate personalized daily missions
      const missions = generateDailyMissionTemplates(avgProblemsPerDay, userLevel);

      // Create missions
      for (const template of missions) {
        await createMission(user._id, template);
      }

      generated++;
    }

    logger.info(`[missions] Daily mission generation complete: ${generated} users, ${skipped} skipped`);
  } catch (error) {
    logger.error('[missions] Daily mission generation failed', { error });
    throw error;
  }
}

export async function generateWeeklyMissions(): Promise<void> {
  logger.info('[missions] Starting weekly mission generation');

  try {
    // Get active users (active within last 14 days for weekly missions)
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const activeUsers = await User.find({
      lastActiveAt: { $gte: fourteenDaysAgo },
    }).select('_id');

    logger.info(`[missions] Found ${activeUsers.length} active users for weekly missions`);

    let generated = 0;
    let skipped = 0;

    for (const user of activeUsers) {
      const userId = user._id.toString();

      // Expire old weekly missions
      await Mission.updateMany(
        {
          userId: user._id,
          type: 'weekly',
          status: { $in: ['pending', 'in_progress'] },
          expiresAt: { $lt: new Date() },
        },
        { $set: { status: 'expired' } }
      );

      await cacheManager.invalidateDashboard(userId);

      // Check if user already has active weekly missions
      const existingWeeklyMissions = await Mission.countDocuments({
        userId: user._id,
        type: 'weekly',
        status: { $in: ['pending', 'in_progress'] },
        expiresAt: { $gte: new Date() },
      });

      if (existingWeeklyMissions > 0) {
        skipped++;
        continue;
      }

      // Get user's stats to calibrate difficulty
      const userXp = await UserXp.findOne({ userId: user._id });
      const avgProblemsPerDay = calculateAvgProblemsPerDay(userXp);
      const userLevel = userXp?.currentLevel ?? 1;

      // Generate personalized weekly missions
      const missions = generateWeeklyMissionTemplates(avgProblemsPerDay, userLevel);

      // Create missions
      for (const template of missions) {
        await createMission(user._id, template);
      }

      generated++;
    }

    logger.info(`[missions] Weekly mission generation complete: ${generated} users, ${skipped} skipped`);
  } catch (error) {
    logger.error('[missions] Weekly mission generation failed', { error });
    throw error;
  }
}

// ─── Mission template generators ─────────────────────────────────────────────

function generateDailyMissionTemplates(avgProblemsPerDay: number, userLevel: number): MissionTemplate[] {
  const missions: MissionTemplate[] = [];

  // Mission 1: Solve N problems today (calibrated to user's average)
  const targetProblems = Math.max(1, Math.min(5, Math.ceil(avgProblemsPerDay * 1.2)));
  missions.push({
    title: `Solve ${targetProblems} problem${targetProblems > 1 ? 's' : ''} today`,
    description: `Complete ${targetProblems} coding problem${targetProblems > 1 ? 's' : ''} to maintain your momentum`,
    type: 'daily',
    category: 'dsa',
    targetCount: targetProblems,
    xpReward: targetProblems * 10,
    expiresInHours: 24,
  });

  // Mission 2: Solve a problem of appropriate difficulty
  const difficulty = userLevel <= 3 ? 'easy' : userLevel <= 7 ? 'medium' : 'hard';
  missions.push({
    title: `Solve a ${difficulty} problem`,
    description: `Challenge yourself with a ${difficulty} difficulty problem`,
    type: 'daily',
    category: 'dsa',
    targetCount: 1,
    xpReward: difficulty === 'easy' ? 15 : difficulty === 'medium' ? 25 : 40,
    expiresInHours: 24,
  });

  // Mission 3: Maintain your streak (always present)
  missions.push({
    title: 'Maintain your streak',
    description: 'Complete at least one activity today to keep your streak alive',
    type: 'daily',
    category: 'consistency',
    targetCount: 1,
    xpReward: 20,
    expiresInHours: 24,
  });

  return missions;
}

function generateWeeklyMissionTemplates(avgProblemsPerDay: number, userLevel: number): MissionTemplate[] {
  const missions: MissionTemplate[] = [];

  // Mission 1: Solve N problems this week
  const weeklyTarget = Math.max(5, Math.min(35, Math.ceil(avgProblemsPerDay * 7 * 1.3)));
  missions.push({
    title: `Solve ${weeklyTarget} problems this week`,
    description: `Complete ${weeklyTarget} coding problems by end of week`,
    type: 'weekly',
    category: 'dsa',
    targetCount: weeklyTarget,
    xpReward: weeklyTarget * 5,
    expiresInHours: 7 * 24,
  });

  // Mission 2: Complete hard problems (for advanced users)
  if (userLevel >= 5) {
    const hardTarget = Math.max(2, Math.min(10, Math.ceil(avgProblemsPerDay * 0.5)));
    missions.push({
      title: `Complete ${hardTarget} hard problems`,
      description: `Push your limits with ${hardTarget} hard difficulty problems`,
      type: 'weekly',
      category: 'dsa',
      targetCount: hardTarget,
      xpReward: hardTarget * 20,
      expiresInHours: 7 * 24,
    });
  }

  // Mission 3: Participate in a contest
  missions.push({
    title: 'Participate in a contest',
    description: 'Join at least one coding contest this week',
    type: 'weekly',
    category: 'dsa',
    targetCount: 1,
    xpReward: 100,
    expiresInHours: 7 * 24,
  });

  return missions;
}

// ─── Helper functions ────────────────────────────────────────────────────────

function calculateAvgProblemsPerDay(userXp: any): number {
  if (!userXp?.lifetimeStats?.totalProblemsSolved) return 1;

  // Simple heuristic: assume user has been active for at least 7 days
  // In production, you'd track actual active days
  const totalSolved = userXp.lifetimeStats.totalProblemsSolved;
  const estimatedActiveDays = Math.max(7, totalSolved / 2); // Assume at least 2 problems per active day
  const avg = totalSolved / estimatedActiveDays;

  return Math.max(1, Math.round(avg));
}

async function createMission(userId: Types.ObjectId, template: MissionTemplate): Promise<IMission> {
  const expiresAt = new Date(Date.now() + template.expiresInHours * 60 * 60 * 1000);

  const mission = await Mission.create({
    userId,
    title: template.title,
    description: template.description,
    type: template.type,
    category: template.category,
    targetCount: template.targetCount,
    currentCount: 0,
    xpReward: template.xpReward,
    status: 'pending',
    expiresAt,
  });

  await cacheManager.invalidateDashboard(userId.toString());

  // Emit SSE notification for new mission
  eventBus.emitNotificationCreated(
    userId.toString(),
    mission._id.toString(),
    'mission_created',
    'New Mission Available',
    template.title,
    'calm',
    'low'
  );

  logger.debug('[missions] Mission created', {
    userId: userId.toString(),
    missionId: mission._id.toString(),
    title: template.title,
    type: template.type,
  });

  return mission;
}
