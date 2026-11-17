// src/modules/leagues/workers/weeklyRollover.worker.ts — Sunday 00:00 UTC league rollover.
// A BullMQ repeatable job fires the rollover; the work itself is runWeeklyRollover, which is
// idempotent per week key, so a retry or a duplicate trigger is harmless.

import { Worker, Job } from 'bullmq';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { QueueNames, JobRetryConfig, type LeagueRolloverJobData } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { logger } from '../../../shared/logger.js';
import { runWeeklyRollover, type RolloverResult } from '../rollover.js';
import { getLeagueScoreStore } from '../scoreStore.js';
import { isValidWeekKey, previousWeekKey, weekKeyFor } from '../weeks.js';

/** Every Sunday at 00:00 UTC. */
export const WEEKLY_ROLLOVER_CRON = '0 0 * * 0';

let _worker: Worker<LeagueRolloverJobData> | null = null;

/**
 * Week to finalize for a trigger that ran at `ranAt`: the one before the week `ranAt` is in.
 * A late run (worker was down at midnight) still finalizes the right week.
 */
export function weekToFinalize(ranAt: Date, requested?: string): string {
  if (requested !== undefined) {
    if (!isValidWeekKey(requested)) throw new Error(`Invalid league week key: ${requested}`);
    return requested;
  }
  return previousWeekKey(weekKeyFor(ranAt));
}

export async function processRolloverJob(data: LeagueRolloverJobData, ranAt: Date): Promise<RolloverResult> {
  return runWeeklyRollover(weekToFinalize(ranAt, data.weekKey), { store: getLeagueScoreStore(), now: ranAt });
}

export async function scheduleWeeklyRollover(): Promise<void> {
  await getOrCreateQueue(QueueNames.LEAGUE_ROLLOVER).add(
    'weekly-rollover',
    {},
    {
      repeat: { pattern: WEEKLY_ROLLOVER_CRON, tz: 'UTC' },
      jobId: 'league-weekly-rollover',
      ...JobRetryConfig.standard,
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 10 },
    },
  );
}

export function startWeeklyRolloverWorker(): Worker<LeagueRolloverJobData> {
  if (_worker) return _worker;

  _worker = createDlqWorker<LeagueRolloverJobData>(
    QueueNames.LEAGUE_ROLLOVER,
    async (job: Job<LeagueRolloverJobData>) => {
      const result = await processRolloverJob(job.data, new Date(job.processedOn ?? Date.now()));
      logger.info('[league-rollover] Rollover finished', { event: 'league_rollover_job_done', jobId: job.id, ...result });
      return result;
    },
    { connection: getRedisClient(), concurrency: 1 },
  );

  _worker.on('failed', (job, err) => {
    logger.error('[league-rollover] Job failed', err, { event: 'league_rollover_failed', jobId: job?.id });
  });
  _worker.on('error', err => {
    logger.error('[league-rollover] Worker error', err, { event: 'league_rollover_worker_error' });
  });
  logger.info('[league-rollover] Worker started', { event: 'league_rollover_worker_started', queue: QueueNames.LEAGUE_ROLLOVER });
  return _worker;
}

export async function stopWeeklyRolloverWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
