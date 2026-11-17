// src/modules/leagues/workers/leagueScore.worker.ts — Applies awarded XP to weekly league standings.
// The XP processor enqueues one job per ledger-backed award (after the transaction commits);
// this worker turns it into a ZINCRBY on the user's cohort sorted set.

import { Worker, Job } from 'bullmq';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { QueueNames, JobRetryConfig, type LeagueScoreJobData } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { logger } from '../../../shared/logger.js';
import { recordXpAward } from '../leagues.service.js';
import { getLeagueScoreStore, type LeagueScoreStore } from '../scoreStore.js';

let _worker: Worker<LeagueScoreJobData> | null = null;

export async function enqueueLeagueScore(data: LeagueScoreJobData): Promise<void> {
  await getOrCreateQueue(QueueNames.LEAGUE_SCORE).add('league-score', data, {
    ...JobRetryConfig.xpProcessing,
  });
}

/** Job handler, exported separately so tests can drive it with a fake store. */
export async function processLeagueScoreJob(
  data: LeagueScoreJobData,
  store: LeagueScoreStore = getLeagueScoreStore(),
  now = new Date(),
) {
  const occurredAt = new Date(data.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw new Error('league-score job has an invalid occurredAt');
  return recordXpAward(
    { userId: data.userId, sourceType: data.sourceType, sourceId: data.sourceId, xpAwarded: data.xpAwarded, occurredAt },
    store,
    now,
  );
}

export function startLeagueScoreWorker(): Worker<LeagueScoreJobData> {
  if (_worker) return _worker;

  _worker = createDlqWorker<LeagueScoreJobData>(
    QueueNames.LEAGUE_SCORE,
    async (job: Job<LeagueScoreJobData>) => {
      const result = await processLeagueScoreJob(job.data);
      logger.debug('[league-score] Processed XP award', {
        event: 'league_score_processed',
        jobId: job.id,
        userId: job.data.userId,
        applied: result.applied,
        reason: result.applied ? undefined : result.reason,
      });
      return result;
    },
    { connection: getRedisClient(), concurrency: 10, ...JobRetryConfig.xpProcessing },
  );

  _worker.on('failed', (job, err) => {
    logger.error('[league-score] Job failed', err, { event: 'league_score_failed', jobId: job?.id, userId: job?.data.userId });
  });
  _worker.on('error', err => {
    logger.error('[league-score] Worker error', err, { event: 'league_score_worker_error' });
  });
  logger.info('[league-score] Worker started', { event: 'league_score_worker_started', queue: QueueNames.LEAGUE_SCORE });
  return _worker;
}

export async function stopLeagueScoreWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
