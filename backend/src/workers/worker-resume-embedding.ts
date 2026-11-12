import { Job, Worker } from 'bullmq';
import { WorkerFactory } from '../infrastructure/queues/WorkerFactory.js';
import { getRedisClient } from '../shared/redis/index.js';
import { logger } from '../shared/logger.js';
import { QueueNames, type ResumeEmbeddingJobData } from '../shared/jobs/types.js';
import { ResumeSession } from '../db/models/resumeSession.model.js';
import { EmbeddingProviderAdapter } from '../modules/ai/embedding/EmbeddingProviderAdapter.js';
import { EMBEDDING_VERSION } from '../modules/ai/embedding/embeddingScope.js';
import { EmbeddingPersistenceLayer } from '../modules/ai/embedding/EmbeddingPersistenceLayer.js';

import { ResumeProcessingOrchestrator } from '../modules/resume/orchestration/ResumeProcessingOrchestrator.js';

const orchestrator = new ResumeProcessingOrchestrator(true);
let worker: Worker | null = null;
const embeddingAdapter = new EmbeddingProviderAdapter();
const persistenceLayer = new EmbeddingPersistenceLayer();

/**
 * Safely chunk long documents to avoid provider token limits.
 * Default max length is roughly 4000 chars (approx 1000 tokens).
 */
function chunkTextSafely(text: string, maxLength: number = 4000): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let currentChunk = '';
  const paragraphs = text.split(/\n\s*\n/);

  for (const paragraph of paragraphs) {
    if ((currentChunk.length + paragraph.length) > maxLength && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    // If a single paragraph is longer than maxLength, split by sentences or just substring
    if (paragraph.length > maxLength) {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }
      let remaining = paragraph;
      while (remaining.length > 0) {
        chunks.push(remaining.substring(0, maxLength).trim());
        remaining = remaining.substring(maxLength);
      }
    } else {
      currentChunk += paragraph + '\n\n';
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export async function startResumeEmbeddingWorker(): Promise<Worker> {
  if (worker) {
    logger.warn('[ResumeEmbeddingWorker] Worker already running');
    return worker;
  }

  logger.info('[ResumeEmbeddingWorker] Starting resume embedding worker');

  worker = WorkerFactory.createWorker<ResumeEmbeddingJobData>(
    QueueNames.RESUME_EMBEDDING,
    async (job: Job<ResumeEmbeddingJobData>) => {
      if (job.name === 'resume-stage') {
        if (job.data.generation === undefined) throw new Error('Missing resume stage generation');
        await orchestrator.processQueuedStage(job.data.sessionId, 'EMBEDDING', job.data.generation,
          job.attemptsMade + 1 >= (job.opts.attempts ?? 1));
        return;
      }

      const { sessionId } = job.data;

      logger.info(`[ResumeEmbeddingWorker] Processing embedding job: ${sessionId}`);

      try {
        const session = await ResumeSession.findOne({ sessionId });
        if (!session || !session.parsedContent?.text) {
          throw new Error('Session not found or text not parsed yet');
        }

        const text = session.parsedContent.text;
        
        // Chunking
        const chunks = chunkTextSafely(text);
        logger.info(`[ResumeEmbeddingWorker] Text chunked. Session: ${sessionId}, Chunks: ${chunks.length}, Original Length: ${text.length}`);
        
        // Generate Embeddings
        const scope = session.userId ? { scope: 'user' as const, userId: session.userId.toString() } : undefined;
        const embeddings = await embeddingAdapter.generateEmbeddingBatch(chunks, scope);
        if (!embeddings.length) throw new Error('No resume embeddings generated');
        
        // Persist Embeddings
        const dimensions = embeddings[0]?.dimensions || 1536;
        const provider = embeddings[0]?.provider || 'openai';
        const model = embeddings[0]?.model || 'text-embedding-3-small';

        const savePromises = scope ? embeddings.map((emb, index) =>
          persistenceLayer.saveEmbedding(
            scope,
            sessionId,
            index,
            emb.vector,
            emb.provider,
            emb.model,
            chunks[index],
            'resume'
          )
        ) : [];
        
        await Promise.all(savePromises);

        // Calculate mean-pooled vector for the session state
        const meanVector = Array.from({ length: dimensions }, (_, i) => {
          const sum = embeddings.reduce((acc, curr) => acc + curr.vector[i], 0);
          return parseFloat((sum / embeddings.length).toFixed(6));
        });
        
        session.embeddingState = {
          generated: true,
          vector: meanVector,
          provider: provider as 'openai' | 'gemini',
          dimensions,
          embeddingVersion: EMBEDDING_VERSION,
          generatedAt: new Date()
        };
        session.currentStage = 'SEMANTIC_ANALYZING'; // Progress pipeline
        await session.save();

        logger.info(`[ResumeEmbeddingWorker] Embedding job completed successfully. Session: ${sessionId}, Chunks: ${chunks.length}, Dimensions: ${dimensions}, Provider: ${provider}`);
      } catch (error) {
        logger.error(`[ResumeEmbeddingWorker] Embedding job failed. Session: ${sessionId}`, error);

        // Graceful failure state (don't crash the worker, just update session)
        const session = await ResumeSession.findOne({ sessionId });
        if (session) {
          session.failureState = {
            failed: true,
            failureStage: 'EMBEDDING',
            failureReason: error instanceof Error ? error.message : 'Unknown embedding error',
            failedAt: new Date(),
            retryCount: (session.failureState?.retryCount || 0) + 1
          };
          session.currentStage = 'FAILED';
          await session.save();
        }

        throw error; // Re-throw for BullMQ to handle retries if configured at queue level
      }
    },
    { concurrency: 3, jobTimeoutMs: null }
  );

  worker.on('completed', (job) => {
    logger.info(`[ResumeEmbeddingWorker] Job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[ResumeEmbeddingWorker] Job failed: ${job?.id}`, err);
  });

  logger.info('[ResumeEmbeddingWorker] Resume embedding worker started');

  return worker;
}

export async function stopResumeEmbeddingWorker(): Promise<void> {
  if (!worker) {
    logger.warn('[ResumeEmbeddingWorker] Worker not running');
    return;
  }

  logger.info('[ResumeEmbeddingWorker] Stopping resume embedding worker');
  await worker.close();
  worker = null;
  logger.info('[ResumeEmbeddingWorker] Resume embedding worker stopped');
}

export function getResumeEmbeddingWorkerStatus(): { running: boolean } {
  return { running: worker !== null };
}
