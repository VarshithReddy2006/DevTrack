// src/modules/resume-intelligence/workers/variant-generation.worker.ts
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { Worker, type Job } from 'bullmq';
import { getRedisConnection } from '../../../shared/redis/index.js';
import { ResumeIntelligenceService } from '../services/ResumeIntelligenceService.js';
import { logger } from '../../../shared/logger.js';
import type { Types } from 'mongoose';

export const VARIANT_GENERATION_QUEUE = 'variant-generation';

interface IVariantGenerationJob {
  userId: string;
  roleType: any;
  customWeights?: any;
}

let worker: Worker | null = null;

export function startVariantGenerationWorker(): Worker {
  if (worker) return worker;

  const service = new ResumeIntelligenceService();

  worker = createDlqWorker<IVariantGenerationJob>(
    VARIANT_GENERATION_QUEUE,
    async (job: Job<IVariantGenerationJob>) => {
      logger.info(`[VariantGenerationWorker] Processing job ${job.id}`);
      try {
        const { userId, roleType, customWeights } = job.data;
        await service.generateVariant(userId as unknown as Types.ObjectId, {
          roleType,
          customWeights,
        });
      } catch (error) {
        logger.error(`[VariantGenerationWorker] Error:`, error);
        throw error;
      }
    },
    { connection: getRedisConnection() }
  );

  return worker;
}

export async function stopVariantGenerationWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
