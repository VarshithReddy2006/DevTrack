// src/modules/resume-intelligence/workers/resume-export.worker.ts
import { createDlqWorker } from '../../../shared/jobs/dlq.service.js';
import { Worker, type Job } from 'bullmq';
import { getRedisConnection } from '../../../shared/redis/index.js';
import { ResumeIntelligenceService } from '../services/ResumeIntelligenceService.js';
import { logger } from '../../../shared/logger.js';
import type { Types } from 'mongoose';

export const RESUME_EXPORT_QUEUE = 'resume-export';

interface IResumeExportJob {
  userId: string;
  variantId?: string;
  exportType: 'pdf' | 'docx' | 'txt';
  includeATSAnalysis?: boolean;
}

let worker: Worker | null = null;

export function startResumeExportWorker(): Worker {
  if (worker) return worker;

  const service = new ResumeIntelligenceService();

  worker = createDlqWorker<IResumeExportJob>(
    RESUME_EXPORT_QUEUE,
    async (job: Job<IResumeExportJob>) => {
      logger.info(`[ResumeExportWorker] Processing job ${job.id}`);
      try {
        const { userId, variantId, exportType, includeATSAnalysis } = job.data;
        await service.exportResume(userId as unknown as Types.ObjectId, {
          variantId,
          exportType,
          includeATSAnalysis: includeATSAnalysis ?? true,
        });
      } catch (error) {
        logger.error(`[ResumeExportWorker] Error:`, error);
        throw error;
      }
    },
    { connection: getRedisConnection() }
  );

  return worker;
}

export async function stopResumeExportWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
