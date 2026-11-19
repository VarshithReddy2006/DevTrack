import { Worker, type Job, type Queue } from 'bullmq';
import { DsaContest } from '../../db/models/dsaContest.model.js';
import { CONTEST_RATING_DELAY_MS, CONTEST_RATING_LOOKBACK_MS, syncContestRatings } from '../../modules/contests/contestRatingSync.service.js';
import { ContestProviderRateLimit } from '../../modules/contests/contestRatingSources.js';
import { getOrCreateQueue } from './queueFactory.js';
import { createDlqWorker } from './dlq.service.js';
import { getRedisClient } from '../redis/client.js';
import { QueueNames } from './types.js';

export type ContestRatingJob = { task: 'sweep' } | { task: 'sync'; contestId: string };
let worker: Worker<ContestRatingJob> | null = null;
const options = { attempts: 5, backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { age: 8 * 24 * 3600 }, removeOnFail: { age: 8 * 24 * 3600 } };
const queue = () => getOrCreateQueue(QueueNames.CONTEST_RATING_SYNC);

export async function enqueueContestRatingSyncs(target: Pick<Queue, 'add'> = queue(), now = new Date()): Promise<number> {
  let enqueued = 0;
  const hour = Math.floor(now.getTime() / 3600_000);
  for await (const contest of DsaContest.find({
    kind: 'scheduled', platform: { $in: ['codeforces', 'leetcode'] },
    externalId: { $type: 'string' },
    endTime: { $lte: new Date(now.getTime() - CONTEST_RATING_DELAY_MS), $gte: new Date(now.getTime() - CONTEST_RATING_LOOKBACK_MS) },
  }).select('_id').cursor()) {
    await target.add('contest-rating-sync', { task: 'sync', contestId: contest._id.toString() }, {
      ...options, jobId: `contest-rating-${contest._id}-${hour}`,
    });
    enqueued++;
  }
  return enqueued;
}

export async function processContestRatingJob(job: Pick<Job<ContestRatingJob>, 'data'>) {
  try {
    return job.data.task === 'sweep' ? await enqueueContestRatingSyncs() : await syncContestRatings(job.data.contestId);
  } catch (error) {
    if (error instanceof ContestProviderRateLimit && worker) {
      await worker.rateLimit(error.retryAfterMs);
      throw Worker.RateLimitError();
    }
    throw error;
  }
}

export function startContestRatingSyncWorker(): Worker<ContestRatingJob> {
  worker ??= createDlqWorker<ContestRatingJob>(QueueNames.CONTEST_RATING_SYNC, processContestRatingJob, {
    connection: getRedisClient(), concurrency: 1, limiter: { max: 1, duration: 2100 },
  });
  return worker;
}

export async function scheduleContestRatingSync(): Promise<void> {
  await queue().add('contest-rating-sweep', { task: 'sweep' }, {
    ...options, jobId: 'contest-rating-sweep', repeat: { every: 15 * 60_000 },
  });
  await queue().add('contest-rating-sweep-startup', { task: 'sweep' }, {
    ...options, jobId: `contest-rating-startup-${Math.floor(Date.now() / (15 * 60_000))}`,
  });
}

export async function stopContestRatingSyncWorker(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
}
