// src/infrastructure/queues/WorkerFactory.ts
import { Worker, Job, WorkerOptions } from 'bullmq';
import { getRedisClient } from '../../shared/redis/index.js';
import { logger } from '../../shared/logger.js';
import { ErrorClassifier, NonRetryableError } from './ErrorClassifier.js';
import { DeadLetterHandler } from './DeadLetterHandler.js';
import { RetryPolicy } from './RetryPolicy.js';

export class WorkerFactory {
  /**
   * Creates a standardized BullMQ worker with built-in telemetry, dead-letter routing,
   * error classification, and custom backoff strategy.
   * 
   * @param queueName Name of the queue
   * @param processor Async function that processes the job
   * @param options Additional worker options (concurrency, etc)
   */
  static createWorker<T>(
    queueName: string,
    processor: (job: Job<T>) => Promise<any>,
    options?: Partial<WorkerOptions>
  ): Worker<T> {
    
    const worker = new Worker<T>(
      queueName,
      async (job: Job<T>) => {
        const jobId = job.id || 'unknown';
        logger.info(`[Worker:${queueName}] Started Job ${jobId}`);
        
        try {
          // Timeout protection (e.g. max 5 minutes per job to prevent hanging)
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Job execution timed out after 5 minutes')), 5 * 60 * 1000);
          });
          
          try { await Promise.race([processor(job), timeoutPromise]); }
          finally { clearTimeout(timer); }

          logger.info(`[Worker:${queueName}] Completed Job ${jobId}`);
        } catch (error) {
          logger.error(`[Worker:${queueName}] Failed Job ${jobId} on attempt ${job.attemptsMade + 1}`, error);
          
          // Classify the error
          const classifiedError = ErrorClassifier.classify(error);
          
          if (classifiedError instanceof NonRetryableError) {
            logger.warn(`[Worker:${queueName}] Job ${jobId} encountered NonRetryableError. Discarding to DLQ.`);
            await DeadLetterHandler.handlePermanentFailure(queueName, `Worker:${queueName}`, job, classifiedError);
            // We tell BullMQ not to retry this by discarding it immediately
            job.discard(); 
            throw classifiedError;
          }

          // If retryable, check if we've exhausted attempts
          if (job.attemptsMade >= (job.opts.attempts || RetryPolicy.MAX_ATTEMPTS) - 1) {
            logger.error(`[Worker:${queueName}] Job ${jobId} exhausted all retries. Moving to DLQ.`);
            await DeadLetterHandler.handlePermanentFailure(queueName, `Worker:${queueName}`, job, classifiedError);
            throw classifiedError;
          }

          // Otherwise, it's retryable and we have attempts left. Throw to let BullMQ retry.
          throw classifiedError;
        }
      },
      {
        connection: getRedisClient(),
        concurrency: options?.concurrency || 3,
        settings: {
          backoffStrategy: RetryPolicy.getCustomBackoffLogic()
        },
        ...options
      }
    );

    worker.on('failed', (job, err) => {
      // Handled internally by process wrapper, but useful for overall worker telemetry
    });

    worker.on('stalled', (jobId) => {
      logger.warn(`[Worker:${queueName}] Job ${jobId} stalled. Recovery workflow initiated.`);
    });

    worker.on('error', (err) => {
      logger.error(`[Worker:${queueName}] Internal Worker Error`, err);
    });

    logger.info(`[WorkerFactory] Spawned worker for queue: ${queueName}`);
    return worker;
  }
}
