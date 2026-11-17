// src/modules/profile/workers/dossierRender.worker.ts — Renders Verified Developer Dossier PDFs.
// Runs only under WORKER_TYPE=render (or all): Chromium never starts in the API process.

import { Worker, type Job } from 'bullmq';
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { QueueNames, type DossierRenderJobData } from '../../../shared/jobs/types.js';
import { getRedisClient } from '../../../shared/redis/index.js';
import { logger } from '../../../shared/logger.js';
import { markFailed, renderDossierArtifact } from '../dossier/dossier.service.js';

let _worker: Worker<DossierRenderJobData> | null = null;

const ATTEMPTS = 2;

/** One job per user at a time: the job id is the user id, so repeated requests share it. */
export async function enqueueDossierRender(userId: string): Promise<void> {
  await getOrCreateQueue(QueueNames.DOSSIER_RENDER).add('dossier-render', { userId }, {
    jobId: `dossier-${userId}`,
    attempts: ATTEMPTS,
    backoff: { type: 'fixed', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export function startDossierRenderWorker(): Worker<DossierRenderJobData> {
  if (_worker) return _worker;

  _worker = createDlqWorker<DossierRenderJobData>(
    QueueNames.DOSSIER_RENDER,
    async (job: Job<DossierRenderJobData>) => renderDossierArtifact(job.data.userId),
    // One Chromium at a time per worker process; the PDF renderer also caps itself at two.
    { connection: getRedisClient(), concurrency: 1 },
  );

  _worker.on('failed', (job, err) => {
    logger.error('[dossier-render] Job failed', err, { event: 'dossier_render_failed', jobId: job?.id, userId: job?.data.userId });
    // Only the last attempt is terminal; earlier ones are retried and the row stays pending.
    if (job && job.attemptsMade >= (job.opts.attempts ?? ATTEMPTS)) {
      void markFailed(job.data.userId, 'render_failed').catch(error => {
        logger.warn('[dossier-render] Could not record failure', { userId: job.data.userId, error: String(error) });
      });
    }
  });
  _worker.on('error', err => {
    logger.error('[dossier-render] Worker error', err, { event: 'dossier_render_worker_error' });
  });
  logger.info('[dossier-render] Worker started', { event: 'dossier_render_worker_started', queue: QueueNames.DOSSIER_RENDER });
  return _worker;
}

export async function stopDossierRenderWorker(): Promise<void> {
  if (!_worker) return;
  await _worker.close();
  _worker = null;
}
