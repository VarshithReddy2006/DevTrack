import type { Queue } from 'bullmq';
import type { SystemMaintenanceJobData } from '../../shared/jobs/types.js';
import { withDistributedLock } from '../../shared/redis/distributedLock.js';
import { expireStaleQuests, type QuestExpirationSweepResult } from './questEngine.service.js';

export const QUEST_EXPIRATION_LOCK_KEY = 'quests:expiration:sweep';
export const QUEST_EXPIRATION_BATCH_SIZE = 200;

export interface QuestExpirationWorkerOptions {
  batchSize?: number;
  now?: Date;
  archiveAfterDays?: number;
}

export type QuestExpirationWorkerResult =
  | ({ executed: true } & QuestExpirationSweepResult)
  | {
      executed: false;
      reason: 'lock_held' | 'redis_unavailable' | 'redis_error';
      expiredCount: number;
      archivedCount: number;
      invalidatedUsers: number;
    };

/**
 * Executes the quest expiration and archival sweep under a distributed Redis lock
 * so overlapping worker replicas never process the same stale quests concurrently.
 */
export async function runQuestExpirationWorkerSweep(
  options: QuestExpirationWorkerOptions = {}
): Promise<QuestExpirationWorkerResult> {
  const {
    batchSize = QUEST_EXPIRATION_BATCH_SIZE,
    now = new Date(),
    archiveAfterDays = 90,
  } = options;

  const lockResult = await withDistributedLock(
    'expire_quests',
    async () => expireStaleQuests(batchSize, now, archiveAfterDays),
    {
      lockKey: QUEST_EXPIRATION_LOCK_KEY,
      ttlMs: 10 * 60 * 1000,
      autoRenew: true,
    }
  );

  if (!lockResult.executed || !lockResult.result) {
    return {
      executed: false,
      reason:
        lockResult.reason === 'redis_unavailable' || lockResult.reason === 'redis_error'
          ? lockResult.reason
          : 'lock_held',
      expiredCount: 0,
      archivedCount: 0,
      invalidatedUsers: 0,
    };
  }

  return {
    executed: true,
    ...lockResult.result,
  };
}

/**
 * Registers repeatable BullMQ jobs for daily reset (00:00 UTC) and
 * weekly rollover (Monday 00:05 UTC) quest expiration sweeps.
 */
export async function scheduleQuestExpiration(
  queue: Pick<Queue<SystemMaintenanceJobData>, 'add' | 'removeRepeatable'>
): Promise<void> {
  // Retire the Sunday 23:59 schedule, which ran before the weekly quests had expired.
  await queue.removeRepeatable(
    'expire-quests-weekly',
    { pattern: '59 23 * * 0', tz: 'UTC' },
    'quests-expire-weekly'
  );

  for (const [name, pattern] of [
    ['daily', '0 0 * * *'],
    ['weekly', '5 0 * * 1'],
  ] as const) {
    await queue.add(
      `expire-quests-${name}`,
      { task: 'expire_quests' },
      {
        repeat: { pattern, tz: 'UTC' },
        jobId: `quests-expire-${name}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { count: 5 },
        removeOnFail: { count: 10 },
      }
    );
  }
}
