// src/shared/scheduler/missionScheduler.ts
// Mission generation sweep. The daily (00:05 UTC) and weekly (Monday 00:05 UTC) schedules are
// BullMQ repeatables registered in shared/jobs/maintenanceWorker.ts, which calls this sweep.

import { randomUUID } from 'node:crypto';
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
