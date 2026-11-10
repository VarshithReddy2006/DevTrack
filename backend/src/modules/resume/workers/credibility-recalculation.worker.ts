// src/modules/resume-intelligence/workers/credibility-recalculation.worker.ts
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { Worker, type Job } from 'bullmq';
import { getRedisConnection } from '../../../shared/redis/index.js';
import { ResumeIntelligenceService } from '../services/ResumeIntelligenceService.js';
import { logger } from '../../../shared/logger.js';
import type { Types } from 'mongoose';

export const CREDIBILITY_RECALCULATION_QUEUE = 'credibility-recalculation';

interface ICredibilityJob {
  userId: string;
}

let worker: Worker | null = null;

export function startCredibilityWorker(): void {
  if (worker) return;

  const service = new ResumeIntelligenceService();

  worker = createDlqWorker<ICredibilityJob>(
    CREDIBILITY_RECALCULATION_QUEUE,
    async (job: Job<ICredibilityJob>) => {
      logger.info(`[CredibilityWorker] Processing job ${job.id}`);
      try {
        const { userId } = job.data;
        await service.getCredibilityAnalysis(userId as unknown as Types.ObjectId);
      } catch (error) {
        logger.error(`[CredibilityWorker] Error:`, error);
        throw error;
      }
    },
    { connection: getRedisConnection() }
  );
}

export async function stopCredibilityWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
