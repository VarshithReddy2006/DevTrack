// src/modules/resume-intelligence/workers/resume-generation.worker.ts
import { Worker, type Job } from 'bullmq';
import { getRedisConnection } from '../../../shared/redis/index.js';
import { ResumeIntelligenceService } from '../services/ResumeIntelligenceService.js';
import { logger } from '../../../shared/logger.js';
import type { Types } from 'mongoose';

export const RESUME_GENERATION_QUEUE = 'resume-generation';

interface IResumeGenerationJob {
  userId: string;
  variantType?: string;
}

let worker: Worker | null = null;

/**
 * Start resume generation worker
 */
export function startResumeGenerationWorker(): Worker {
  if (worker) {
    logger.warn('[ResumeGenerationWorker] Worker already running');
    return worker;
  }

  const service = new ResumeIntelligenceService();

  worker = new Worker<IResumeGenerationJob>(
    RESUME_GENERATION_QUEUE,
    async (job: Job<IResumeGenerationJob>) => {
      logger.info(`[ResumeGenerationWorker] Processing job ${job.id}`);

      try {
        const { userId, variantType } = job.data;

        if (variantType) {
          // Generate specific variant
          await service.generateVariant(userId as unknown as Types.ObjectId, {
            roleType: variantType as any,
          });
        } else {
          // Generate full resume
          await service.generateResume(userId as unknown as Types.ObjectId);
        }

        logger.info(`[ResumeGenerationWorker] Completed job ${job.id}`);
      } catch (error) {
        logger.error(`[ResumeGenerationWorker] Error processing job ${job.id}:`, error);
        throw error;
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 60000, // 10 jobs per minute
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info(`[ResumeGenerationWorker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, error) => {
    logger.error(`[ResumeGenerationWorker] Job ${job?.id} failed:`, error);
  });

  logger.info('[ResumeGenerationWorker] Started');

  return worker;
}

/**
 * Stop resume generation worker
 */
export async function stopResumeGenerationWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[ResumeGenerationWorker] Stopped');
  }
}

/**
 * Get worker status
 */
export function getResumeGenerationWorkerStatus(): { running: boolean } {
  return { running: worker !== null };
}
