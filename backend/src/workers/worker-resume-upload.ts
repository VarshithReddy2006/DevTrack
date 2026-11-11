// src/workers/worker-resume-upload.ts
import { Job, Worker } from 'bullmq';
import { WorkerFactory } from '../infrastructure/queues/WorkerFactory.js';
import { logger } from '../shared/logger.js';
import { QueueNames, type ResumeCheckpointJobData, type ResumeUploadJobData } from '../shared/jobs/types.js';
import { artifactStorage } from '../modules/resume/upload/artifact-storage.js';
import { ResumeProcessingOrchestrator } from '../modules/resume/orchestration/ResumeProcessingOrchestrator.js';
import { ResumeSession } from '../db/models/resumeSession.model.js';

let worker: Worker | null = null;
const orchestrator = new ResumeProcessingOrchestrator();

export async function startResumeUploadWorker(): Promise<Worker> {
  if (worker) {
    logger.warn('[ResumeUploadWorker] Worker already running');
    return worker;
  }

  logger.info('[ResumeUploadWorker] Starting resume upload worker');

  worker = WorkerFactory.createWorker<ResumeUploadJobData | ResumeCheckpointJobData>(
    QueueNames.RESUME_UPLOAD,
    async (job: Job<ResumeUploadJobData | ResumeCheckpointJobData>) => {
      const { sessionId, userId } = job.data;

      if ('recoveryRetryCount' in job.data) {
        let session = await ResumeSession.findOne({ sessionId, userId });
        if (session?.currentStage === 'FAILED' && session.failureState?.failed && session.checkpointState?.stage
          && (session.failureState.retryCount ?? 0) === job.data.recoveryRetryCount) {
          await orchestrator.resumeFromCheckpoint(sessionId);
          session = await ResumeSession.findOne({ sessionId });
          if (session?.currentStage === 'COMPLETED' && session.uploadMetadata?.uploadPath) {
            await artifactStorage.remove(session.uploadMetadata.uploadPath);
          }
        }
        return;
      }

      const { filePath, originalFilename } = job.data;

      logger.info(`[ResumeUploadWorker] Processing upload job: ${sessionId}`);

      try {
        // Create or update session
        let session = await ResumeSession.findOne({ sessionId });
        
        if (!session) {
          session = await ResumeSession.create({
            sessionId,
            userId,
            uploadMetadata: {
              originalFilename,
              fileType: originalFilename.split('.').pop() as 'pdf' | 'docx' | 'txt' | 'md',
              fileSize: 0, // Will be updated
              mimeType: '',
              uploadPath: filePath,
              uploadedAt: new Date(),
            },
            currentStage: 'UPLOADED',
            processingHistory: [],
            parsedContent: {
              text: '',
              sections: {},
              headings: [],
              bullets: [],
              links: [],
              metadata: {},
              parsingDiagnostics: {
                confidence: 0,
                warnings: [],
                errors: [],
              },
            },
            atsState: { analyzed: false },
            embeddingState: { generated: false },
            semanticState: { analyzed: false },
            recommendationState: { generated: false },
            replayState: { generated: false },
            failureState: { failed: false },
            degradedState: { degraded: false },
            timestamps: {
              uploadedAt: new Date(),
              lastUpdated: new Date(),
            },
          });
        }

        // A redelivery after completion can retry cleanup without re-parsing.
        if (session.currentStage !== 'COMPLETED') {
          await orchestrator.startProcessing(sessionId);
          session = await ResumeSession.findOne({ sessionId });
        }
        if (session?.currentStage === 'COMPLETED') {
          await artifactStorage.remove(session.uploadMetadata.uploadPath);
        }

        logger.info(`[ResumeUploadWorker] Upload job completed: ${sessionId}`);
      } catch (error) {
        logger.error(`[ResumeUploadWorker] Upload job failed: ${sessionId}`, error);
        throw error;
      }
    },
    { concurrency: 3 }
  );

  worker.on('completed', (job) => {
    logger.info(`[ResumeUploadWorker] Job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[ResumeUploadWorker] Job failed: ${job?.id}`, err);
  });

  logger.info('[ResumeUploadWorker] Resume upload worker started');

  return worker;
}

export async function stopResumeUploadWorker(): Promise<void> {
  if (!worker) {
    logger.warn('[ResumeUploadWorker] Worker not running');
    return;
  }

  logger.info('[ResumeUploadWorker] Stopping resume upload worker');
  await worker.close();
  worker = null;
  logger.info('[ResumeUploadWorker] Resume upload worker stopped');
}

export function getResumeUploadWorkerStatus(): { running: boolean } {
  return { running: worker !== null };
}
