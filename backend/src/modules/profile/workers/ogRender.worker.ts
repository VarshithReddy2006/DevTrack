// src/modules/profile/workers/ogRender.worker.ts — Renders OG cards for the render pool.
// Runs only under WORKER_TYPE=render (or all), so satori and resvg never load in the API
// or XP processes.

import { Worker, type Job } from 'bullmq';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { QueueNames, type OgRenderJobData } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { logger } from '../../../shared/logger.js';
import { renderOgArtifact } from '../ogImage.service.js';

let _worker: Worker<OgRenderJobData> | null = null;

/**
 * Queue a render. The job id carries the content hash, so concurrent requests for the same
 * card share one job. Finished jobs are removed so a later change to the card can queue again.
 */
export async function enqueueOgRender(userId: string, contentHash: string): Promise<void> {
  await getOrCreateQueue(QueueNames.OG_RENDER).add('og-render', { userId }, {
    jobId: `og-${userId}-${contentHash.slice(0, 32)}`,
    attempts: 2,
    backoff: { type: 'fixed', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export function startOgRenderWorker(): Worker<OgRenderJobData> {
  if (_worker) return _worker;

  _worker = createDlqWorker<OgRenderJobData>(
    QueueNames.OG_RENDER,
    async (job: Job<OgRenderJobData>) => renderOgArtifact(job.data.userId),
    // Two at a time: each render is CPU bound and holds a few tens of MB.
    { connection: getRedisClient(), concurrency: 2 },
  );

  _worker.on('failed', (job, err) => {
    logger.error('[og-render] Job failed', err, { event: 'og_render_failed', jobId: job?.id, userId: job?.data.userId });
  });
  _worker.on('error', err => {
    logger.error('[og-render] Worker error', err, { event: 'og_render_worker_error' });
  });
  logger.info('[og-render] Worker started', { event: 'og_render_worker_started', queue: QueueNames.OG_RENDER });
  return _worker;
}

export async function stopOgRenderWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
