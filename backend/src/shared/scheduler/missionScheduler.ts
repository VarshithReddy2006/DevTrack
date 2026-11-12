// src/shared/scheduler/missionScheduler.ts
// Mission generation scheduler — runs daily and weekly mission generation

import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
import { generateDailyMissions, generateWeeklyMissions } from '../../modules/missions/missionGenerator.service.js';
import { getMissionPeriod, type MissionPeriodType } from '../../modules/missions/missionPeriod.js';
import { logger } from '../logger.js';
import { getRedisClient } from '../redis/client.js';

const SWEEP_LOCK_TTL_MS = 15 * 60 * 1000;
const RELEASE_OWNED_LOCK = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

let dailyMissionJob: cron.ScheduledTask | null = null;
let weeklyMissionJob: cron.ScheduledTask | null = null;

export async function runScheduledMissionSweep(type: MissionPeriodType, now = new Date()): Promise<void> {
  const redis = getRedisClient();
  if (redis.status !== 'ready') throw new Error('Redis unavailable for scheduled mission generation');

  const key = `missions:scheduler:${getMissionPeriod(type, now).key}`;
  const token = randomUUID();
  const acquired = await redis.set(key, token, 'PX', SWEEP_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') return;

  try {
    const generate = type === 'daily' ? generateDailyMissions : generateWeeklyMissions;
    await generate(now);
  } finally {
    try {
      await redis.eval(RELEASE_OWNED_LOCK, 1, key, token);
    } catch (error) {
      logger.warn('[scheduler] Failed to release mission sweep lock', { type, error });
    }
  }
}

// ─── Start mission scheduler ─────────────────────────────────────────────────

export function startMissionScheduler(): void {
  if (dailyMissionJob || weeklyMissionJob) return;
  logger.info('[scheduler] Starting mission scheduler');

  // Daily missions: Run at 00:05 UTC every day
  dailyMissionJob = cron.schedule('5 0 * * *', async () => {
    logger.info('[scheduler] Running daily mission generation');
    try {
      await runScheduledMissionSweep('daily');
      logger.info('[scheduler] Daily mission generation completed');
    } catch (error) {
      logger.error('[scheduler] Daily mission generation failed', { error });
    }
  }, {
    timezone: 'UTC',
  });

  // Weekly missions: Run at 00:05 UTC every Monday
  weeklyMissionJob = cron.schedule('5 0 * * 1', async () => {
    logger.info('[scheduler] Running weekly mission generation');
    try {
      await runScheduledMissionSweep('weekly');
      logger.info('[scheduler] Weekly mission generation completed');
    } catch (error) {
      logger.error('[scheduler] Weekly mission generation failed', { error });
    }
  }, {
    timezone: 'UTC',
  });

  logger.info('[scheduler] Mission scheduler started (daily: 00:05 UTC, weekly: Monday 00:05 UTC)');
}

// ─── Stop mission scheduler ──────────────────────────────────────────────────

export function stopMissionScheduler(): void {
  logger.info('[scheduler] Stopping mission scheduler');

  if (dailyMissionJob) {
    dailyMissionJob.stop();
    dailyMissionJob = null;
  }

  if (weeklyMissionJob) {
    weeklyMissionJob.stop();
    weeklyMissionJob = null;
  }

  logger.info('[scheduler] Mission scheduler stopped');
}

// ─── Get scheduler status ────────────────────────────────────────────────────

export function getMissionSchedulerStatus(): {
  running: boolean;
  dailyJobActive: boolean;
  weeklyJobActive: boolean;
} {
  return {
    running: dailyMissionJob !== null || weeklyMissionJob !== null,
    dailyJobActive: dailyMissionJob !== null,
    weeklyJobActive: weeklyMissionJob !== null,
  };
}
