// src/shared/scheduler/missionScheduler.ts
// Mission generation sweep. The daily (00:05 UTC) and weekly (Monday 00:05 UTC) schedules are
// BullMQ repeatables registered in shared/jobs/maintenanceWorker.ts, which calls this sweep.

import { generateDailyMissions, generateWeeklyMissions } from '../../modules/missions/missionGenerator.service.js';
import { getMissionPeriod, type MissionPeriodType } from '../../modules/missions/missionPeriod.js';
import { logger } from '../logger.js';
import { getRedisClient } from '../redis/client.js';
import { acquireDistributedLock } from '../redis/distributedLock.js';

const SWEEP_LOCK_TTL_MS = 15 * 60 * 1000;

export async function runScheduledMissionSweep(type: MissionPeriodType, now = new Date()): Promise<void> {
  const redis = getRedisClient();
  if (redis.status !== 'ready') throw new Error('Redis unavailable for scheduled mission generation');

  const key = `missions:scheduler:${getMissionPeriod(type, now).key}`;
  const lock = await acquireDistributedLock(`mission_sweep_${type}`, {
    lockKey: key,
    ttlMs: SWEEP_LOCK_TTL_MS,
    fallbackOnRedisUnavailable: false,
  });
  if (!lock) return;

  let completed = false;
  try {
    const generate = type === 'daily' ? generateDailyMissions : generateWeeklyMissions;
    await generate(now);
    completed = true;
  } finally {
    if (!completed) {
      try {
        await lock.release();
      } catch (error) {
        logger.warn('[scheduler] Failed to release mission sweep lock', { type, error });
      }
    }
  }
}
