// src/modules/resume-intelligence/workers/ats-analysis.worker.ts
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { Worker, type Job } from 'bullmq';
import { getRedisConnection } from '../../../shared/redis/index.js';
import { ResumeIntelligenceService } from '../services/ResumeIntelligenceService.js';
import { logger } from '../../../shared/logger.js';
import type { Types } from 'mongoose';

export const ATS_ANALYSIS_QUEUE = 'ats-analysis';

interface IATSAnalysisJob {
  userId: string;
  variantId?: string;
  targetKeywords?: string[];
}

let worker: Worker | null = null;

export function startATSAnalysisWorker(): Worker {
  if (worker) return worker;

  const service = new ResumeIntelligenceService();

  worker = createDlqWorker<IATSAnalysisJob>(
    ATS_ANALYSIS_QUEUE,
    async (job: Job<IATSAnalysisJob>) => {
      logger.info(`[ATSAnalysisWorker] Processing job ${job.id}`);
      try {
        const { userId, variantId, targetKeywords } = job.data;
        await service.analyzeATS(userId as unknown as Types.ObjectId, {
          variantId,
          targetKeywords,
        });
      } catch (error) {
        logger.error(`[ATSAnalysisWorker] Error:`, error);
        throw error;
      }
    },
    { connection: getRedisConnection() }
  );

  return worker;
}

export async function stopATSAnalysisWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
