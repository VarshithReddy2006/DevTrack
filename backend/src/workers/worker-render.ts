// backend/src/workers/worker-render.ts
// Background compilation worker for Typst and LaTeX vector ATS resume PDFs
// Runs in the render worker pool (WORKER_TYPE=render) with hard latency < 2.0s

import { Worker, type Job } from 'bullmq';
import fs from 'node:fs/promises';
import path from 'node:path';
import { QueueNames, type ResumeRenderJobData } from '../shared/jobs/types.js';
import { createDlqWorker } from '../shared/jobs/dlq.service.js';
import { getOrCreateQueue } from '../shared/jobs/queueFactory.js';
import { getRedisClient } from '../shared/redis/index.js';
import { logger } from '../shared/logger.js';
import {
  typstCompilerService,
  type TypstCompilerOptions,
  type TypstCompilationResult,
} from '../modules/resume/export/typstCompiler.service.js';
import type { StructuredResume } from '../modules/resume/export/latexTemplates.js';

let worker: Worker<ResumeRenderJobData> | null = null;

export interface ResumeRenderJobResult {
  success: boolean;
  pageCount: number;
  durationMs: number;
  fileSize: number;
  template: string;
  exportPath?: string;
}

/**
 * Process a resume compilation job
 */
export async function processResumeRenderJob(
  job: Job<ResumeRenderJobData>
): Promise<ResumeRenderJobResult> {
  const startedAt = performance.now();
  const { userId, resumeData, options, exportPath } = job.data;

  logger.info(`[worker-render] Processing resume render job ${job.id} for user ${userId}`);

  try {
    const compilationResult: TypstCompilationResult = await typstCompilerService.compileToPdf(
      resumeData as unknown as StructuredResume,
      options as TypstCompilerOptions
    );

    let savedPath: string | undefined;
    if (exportPath) {
      const fullPath = path.isAbsolute(exportPath)
        ? exportPath
        : path.join(process.cwd(), exportPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, compilationResult.pdf);
      savedPath = fullPath;
    }

    const durationMs = performance.now() - startedAt;
    logger.info(
      `[worker-render] Successfully rendered resume for user ${userId} in ${durationMs.toFixed(2)}ms`,
      {
        pageCount: compilationResult.pageCount,
        fileSize: compilationResult.metadata.fileSize,
      }
    );

    return {
      success: true,
      pageCount: compilationResult.pageCount,
      durationMs,
      fileSize: compilationResult.metadata.fileSize,
      template: compilationResult.template,
      exportPath: savedPath,
    };
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    logger.error(`[worker-render] Failed to render resume for user ${userId} after ${durationMs.toFixed(2)}ms:`, error);
    throw error;
  }
}

/**
 * Enqueue a resume rendering job onto BullMQ
 */
export async function enqueueResumeRender(
  data: ResumeRenderJobData
): Promise<Job<ResumeRenderJobData>> {
  const queue = getOrCreateQueue(QueueNames.RESUME_RENDER);
  return queue.add('compile-resume', data, {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  });
}

/**
 * Start the resume render worker
 */
export function startResumeRenderWorker(): Worker<ResumeRenderJobData> {
  if (worker) return worker;

  worker = createDlqWorker<ResumeRenderJobData>(
    QueueNames.RESUME_RENDER,
    async (job: Job<ResumeRenderJobData>) => {
      return processResumeRenderJob(job);
    },
    {
      connection: getRedisClient(),
      concurrency: 4,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(`[worker-render] Job ${job?.id} failed:`, err);
  });

  logger.info('[worker-render] Resume render worker initialized and listening on queue', {
    queue: QueueNames.RESUME_RENDER,
  });
  return worker;
}

/**
 * Stop the resume render worker
 */
export async function stopResumeRenderWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[worker-render] Resume render worker stopped');
  }
}

// Aliases for unified render worker pool
export const startRenderWorker = startResumeRenderWorker;
export const stopRenderWorker = stopResumeRenderWorker;

// CLI standalone runner
if (process.argv[1] && process.argv[1].endsWith('worker-render.ts')) {
  logger.info('[worker-render] Starting standalone render worker process');
  startResumeRenderWorker();

  const shutdown = async () => {
    logger.info('[worker-render] Shutting down render worker process');
    await stopResumeRenderWorker();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
