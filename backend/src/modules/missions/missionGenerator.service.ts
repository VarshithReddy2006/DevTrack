// src/modules/missions/missionGenerator.service.ts
// Mission auto-generation service — generates daily and weekly missions for active users

import { cacheManager } from '../../shared/cache/cacheManager.js';
import { Types } from 'mongoose';
import { Mission, UserXp, User, type IMission } from '../../db/models/index.js';
import { logger } from '../../shared/logger.js';
import { eventBus } from '../../shared/sse/index.js';
import { getMissionPeriod, type MissionPeriodType } from './missionPeriod.js';

interface MissionTemplate {
  title: string;
  description: string;
  type: 'daily' | 'weekly';
  category: 'dsa' | 'project' | 'learning' | 'consistency';
  targetCount: number;
  xpReward: number;
  key: string;
}

// ─── Mission generation logic ────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export async function generateDailyMissions(now = new Date()): Promise<void> {
  await generateMissions('daily', now);
}

export async function generateWeeklyMissions(now = new Date()): Promise<void> {
  await generateMissions('weekly', now);
}

async function generateMissions(type: MissionPeriodType, now: Date): Promise<void> {
  // The partial unique index must be ready before replicas can upsert missions.
  await Mission.init();
  const period = getMissionPeriod(type, now);
  const activeWindowDays = type === 'daily' ? 7 : 14;
  const activeUsers = await User.find({
    lastActiveAt: { $gte: new Date(now.getTime() - activeWindowDays * DAY_MS) },
  }).select('_id');
  const templatesFor = type === 'daily' ? generateDailyMissionTemplates : generateWeeklyMissionTemplates;

  for (const user of activeUsers) {
    const userId = user._id;
    const expired = await Mission.updateMany(
      { userId, type, status: { $in: ['pending', 'in_progress'] }, expiresAt: { $lte: now } },
      { $set: { status: 'expired' } },
    );
    if (expired.modifiedCount) await cacheManager.invalidateDashboard(userId.toString());

    // During rollout, keep a legacy batch already created for this period or still active.
    const legacyBatch = await Mission.exists({
      userId, type, periodKey: { $exists: false },
      $or: [
        { createdAt: { $gte: period.start, $lt: period.end } },
        { status: { $in: ['pending', 'in_progress'] }, expiresAt: { $gt: now } },
      ],
    });
    if (legacyBatch) continue;

    const xp = await UserXp.findOne({ userId }).lean();
    const calibration = { averageProblemsPerDay: calculateAvgProblemsPerDay(xp), level: xp?.currentLevel ?? 1 };
    const [primary] = templatesFor(calibration.averageProblemsPerDay, calibration.level);
    // The primary mission freezes the calibration for the entire batch, including after partial failure.
    const anchor = await upsertMission(userId, period, primary, calibration);
    const saved = anchor.generationCalibration!;
    const [, ...remaining] = templatesFor(saved.averageProblemsPerDay, saved.level);
    for (const template of remaining) {
      await upsertMission(userId, period, template);
    }
  }

  logger.info('[missions] Mission generation complete', { type, period: period.key, activeUsers: activeUsers.length });
}

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
    key: 'solve-count',
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
    key: 'solve-difficulty',
  });

  // Mission 3: Maintain your streak (always present)
  missions.push({
    title: 'Maintain your streak',
    description: 'Complete at least one activity today to keep your streak alive',
    type: 'daily',
    category: 'consistency',
    targetCount: 1,
    xpReward: 20,
    key: 'streak',
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
    key: 'solve-count',
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
      key: 'hard-count',
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
    key: 'contest',
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

async function upsertMission(
  userId: Types.ObjectId,
  period: ReturnType<typeof getMissionPeriod>,
  template: MissionTemplate,
  generationCalibration?: IMission['generationCalibration'],
): Promise<IMission> {
  const { key: templateKey, ...fields } = template;
  const identity = { userId, type: template.type, periodKey: period.key, templateKey };
  let result;
  try {
    result = await Mission.findOneAndUpdate(identity, {
      $setOnInsert: { ...fields, expiresAt: period.end, generationCalibration },
    }, { upsert: true, new: true, includeResultMetadata: true, runValidators: true });
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) throw error;
    const winner = await Mission.findOne(identity);
    if (!winner) throw error;
    return winner;
  }
  const mission = result.value;
  if (!mission) throw new Error('Mission upsert returned no document');
  if (result.lastErrorObject?.upserted) {
    await cacheManager.invalidateDashboard(userId.toString());
    eventBus.emitNotificationCreated(
      userId.toString(), mission._id.toString(), 'mission_created', 'New Mission Available', mission.title, 'calm', 'low',
    );
  }
  return mission;
}
