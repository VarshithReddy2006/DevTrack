// src/workers/worker-resume-ats.ts
import { Job, Worker } from 'bullmq';
import { WorkerFactory } from '../infrastructure/queues/WorkerFactory.js';
import { getRedisClient } from '../shared/redis/index.js';
import { logger } from '../shared/logger.js';
import { QueueNames, type ResumeATSJobData } from '../shared/jobs/types.js';
import { ResumeSession } from '../db/models/resumeSession.model.js';
import { ATSCompatibilityEngine } from '../modules/resume/ats/ATSCompatibilityEngine.js';
import { ResumeProfile } from '../db/models/resumeProfile.model.js';
import type { Types } from 'mongoose';

let worker: Worker | null = null;
const atsEngine = new ATSCompatibilityEngine();

export async function startResumeATSWorker(): Promise<Worker> {
  if (worker) {
    logger.warn('[ResumeATSWorker] Worker already running');
    return worker;
  }

  logger.info('[ResumeATSWorker] Starting resume ATS worker');

  worker = WorkerFactory.createWorker<ResumeATSJobData>(
    QueueNames.RESUME_ATS,
    async (job: Job<ResumeATSJobData>) => {
      const { sessionId } = job.data;

      logger.info(`[ResumeATSWorker] Processing ATS job: ${sessionId}`);

      try {
        const session = await ResumeSession.findOne({ sessionId });
        if (!session) {
          throw new Error(`Resume session not found for ATS analysis: ${sessionId}`);
        }

        logger.info(`[ResumeATSWorker] Analyzing resume text for session: ${sessionId}`);
        const content = session.parsedContent.text || '';

        const profile = await ResumeProfile.findOne({ userId: session.userId });
        if (!profile) {
          throw new Error(`Resume profile not found for user: ${session.userId}`);
        }

        const analysis = await atsEngine.analyze({
          userId: session.userId as unknown as Types.ObjectId,
          resumeProfileId: profile._id as Types.ObjectId,
          content,
          targetKeywords: [],
        });

        // Update session's ATS state
        session.atsState = {
          analyzed: true,
          atsScore: analysis.atsScore,
          parserWarnings: analysis.parserWarnings,
          formattingWarnings: analysis.formattingWarnings,
          keywordCoverage: analysis.keywordCoverage,
          sectionIntegrity: analysis.sectionIntegrity,
          extractionConfidence: analysis.extractionConfidence,
          recommendations: analysis.recommendations,
          analyzedAt: new Date(),
        };
        session.timestamps.lastUpdated = new Date();
        await session.save();

        logger.info(`[ResumeATSWorker] ATS job completed successfully: ${sessionId}`);
      } catch (error) {
        logger.error(`[ResumeATSWorker] ATS job failed: ${sessionId}`, error);
        throw error;
      }
    },
    { concurrency: 5 }
  );

  worker.on('completed', (job) => {
    logger.info(`[ResumeATSWorker] Job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[ResumeATSWorker] Job failed: ${job?.id}`, err);
  });

  logger.info('[ResumeATSWorker] Resume ATS worker started');

  return worker;
}

export async function stopResumeATSWorker(): Promise<void> {
  if (!worker) {
    logger.warn('[ResumeATSWorker] Worker not running');
    return;
  }

  logger.info('[ResumeATSWorker] Stopping resume ATS worker');
  await worker.close();
  worker = null;
  logger.info('[ResumeATSWorker] Resume ATS worker stopped');
}

export function getResumeATSWorkerStatus(): { running: boolean } {
  return { running: worker !== null };
}
