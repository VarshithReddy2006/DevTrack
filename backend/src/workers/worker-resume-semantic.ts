import { Job, Worker } from 'bullmq';
import { WorkerFactory } from '../infrastructure/queues/WorkerFactory.js';
import { logger } from '../shared/logger.js';
import { QueueNames, type ResumeSemanticJobData } from '../shared/jobs/types.js';
import { ResumeSession } from '../db/models/resumeSession.model.js';
import { SemanticIntelligenceLayer } from '../modules/resume/ai/SemanticIntelligenceLayer.js';
import { SemanticAnalysis } from '../db/models/semanticAnalysis.model.js';

import { ResumeProcessingOrchestrator } from '../modules/resume/orchestration/ResumeProcessingOrchestrator.js';

const orchestrator = new ResumeProcessingOrchestrator(true);
const semanticLayer = new SemanticIntelligenceLayer();
let worker: Worker | null = null;

export async function startResumeSemanticWorker(): Promise<Worker> {
  if (worker) {
    logger.warn('[ResumeSemanticWorker] Worker already running');
    return worker;
  }

  logger.info('[ResumeSemanticWorker] Starting resume semantic worker');

  worker = WorkerFactory.createWorker<ResumeSemanticJobData>(
    QueueNames.RESUME_SEMANTIC,
    async (job: Job<ResumeSemanticJobData>) => {
      if (job.name === 'resume-stage') {
        if (job.data.generation === undefined) throw new Error('Missing resume stage generation');
        await orchestrator.processQueuedStage(job.data.sessionId, 'SEMANTIC_ANALYZING', job.data.generation,
          job.attemptsMade + 1 >= (job.opts.attempts ?? 1));
        return;
      }

      const { sessionId } = job.data;

      logger.info(`[ResumeSemanticWorker] Processing semantic job: ${sessionId}`);

      try {
        const session = await ResumeSession.findOne({ sessionId });
        if (!session || !session.parsedContent?.text) {
          throw new Error('Session not found or text not parsed yet');
        }

        const { analysis: validatedData, provenance, degradedReason } = await semanticLayer.analyzeResume(
          session.parsedContent.text, session.userId?.toString() ?? sessionId,
        );
        if (!validatedData) throw new Error(degradedReason);

        // Persist to MongoDB
        await SemanticAnalysis.findOneAndUpdate(
          { sessionId },
          { ...validatedData, provenance, sessionId },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Update Session State
        session.semanticState = {
          analyzed: true,
          semanticSimilarity: validatedData.confidenceScore, // Mapping confidenceScore to the existing semanticSimilarity numerical anchor
          analyzedAt: new Date()
        };
        session.currentStage = 'RECOMMENDING'; // Advance the pipeline
        await session.save();

        logger.info(`[ResumeSemanticWorker] Semantic job completed: ${sessionId}. AI confidence: ${validatedData.confidenceScore}`);
      } catch (error) {
        logger.error(`[ResumeSemanticWorker] Semantic job failed: ${sessionId}`, error);
        
        // Safe fallback error handling: Do not crash the queue, mark the session as failed
        const session = await ResumeSession.findOne({ sessionId });
        if (session) {
          session.failureState = {
            failed: true,
            failureStage: 'SEMANTIC_ANALYZING',
            failureReason: error instanceof Error ? error.message : 'Unknown semantic analysis error',
            failedAt: new Date(),
            retryCount: (session.failureState?.retryCount || 0) + 1
          };
          session.currentStage = 'FAILED';
          await session.save();
        }

        throw error; // Re-throw so BullMQ can attempt standard exponential retries
      }
    },
    { concurrency: 3, jobTimeoutMs: null }
  );

  worker.on('completed', (job) => {
    logger.info(`[ResumeSemanticWorker] Job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[ResumeSemanticWorker] Job failed: ${job?.id}`, err);
  });

  logger.info('[ResumeSemanticWorker] Resume semantic worker started');
  return worker;
}

export async function stopResumeSemanticWorker(): Promise<void> {
  if (!worker) {
    logger.warn('[ResumeSemanticWorker] Worker not running');
    return;
  }

  logger.info('[ResumeSemanticWorker] Stopping resume semantic worker');
  await worker.close();
  worker = null;
  logger.info('[ResumeSemanticWorker] Resume semantic worker stopped');
}

export function getResumeSemanticWorkerStatus(): { running: boolean } {
  return { running: worker !== null };
}
