// src/shared/runtime/workerLifecycle.ts — Deployment Safety + Worker Orchestration
// Phase-B: Graceful draining, rolling deployment, worker heartbeat

import { Worker } from 'bullmq';
import { getRedisClient } from '../redis/client.js';
import { logger } from '../logger.js';
import { QueueNames } from '../jobs/types.js';

export interface WorkerHealth {
  workerId: string;
  queueName: string;
  status: 'starting' | 'running' | 'draining' | 'stopping' | 'stopped';
  startedAt: number;
  jobsProcessed: number;
  jobsFailed: number;
  lastHeartbeat: number;
  currentJobId: string | null;
  concurrency: number;
}

export interface DrainingProgress {
  workerId: string;
  activeJobs: number;
  maxDrainTimeMs: number;
  startedAt: number;
  estimatedRemaining: number;
}

// Worker registry for lifecycle management
export class WorkerRegistry {
  private workers = new Map<string, WorkerHealth>();
  private bullWorkers = new Map<string, Worker>();
  private drainingWorkers = new Map<string, DrainingProgress>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private gracefulShutdownTimeout = 30000; // 30 seconds

  // Register a worker (supports optional BullMQ Worker instance)
  register(workerId: string, queueName: string, concurrency: number, bullWorker?: Worker): void {
    this.workers.set(workerId, {
      workerId,
      queueName,
      status: 'starting',
      startedAt: Date.now(),
      jobsProcessed: 0,
      jobsFailed: 0,
      lastHeartbeat: Date.now(),
      currentJobId: null,
      concurrency,
    });

    if (bullWorker) {
      this.bullWorkers.set(workerId, bullWorker);
    }

    logger.info('[lifecycle] Worker registered', { workerId, queueName });
  }

  // Get registered BullMQ Worker instance
  getBullWorker(workerId: string): Worker | undefined {
    return this.bullWorkers.get(workerId);
  }

  // Update worker status
  updateStatus(workerId: string, status: WorkerHealth['status']): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = status;
    }
  }

  // Update job progress
  setCurrentJob(workerId: string, jobId: string | null): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.currentJobId = jobId;
      worker.lastHeartbeat = Date.now();
    }
  }

  // Increment job counters
  incrementProcessed(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.jobsProcessed++;
    }
  }

  incrementFailed(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.jobsFailed++;
    }
  }

  // Start heartbeat monitoring
  startHeartbeat(intervalMs = 10000): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      this.checkWorkerHealth().catch((err) => {
        logger.error('[lifecycle] Heartbeat health check error', err);
      });
    }, intervalMs);

    logger.info('[lifecycle] Heartbeat monitoring started', { intervalMs });
  }

  // Check worker health and stalled jobs
  async checkWorkerHealth(stuckThresholdMs = 300000, now = Date.now()): Promise<void> {
    for (const [workerId, worker] of this.workers) {
      // Check for stale heartbeat
      if (now - worker.lastHeartbeat > 60000) {
        logger.warn('[lifecycle] Worker stale heartbeat', { workerId, lastHeartbeat: worker.lastHeartbeat });
      }

      // Check for stuck jobs (running for > stuckThresholdMs without heartbeat update)
      if (worker.status === 'running' && worker.currentJobId) {
        if (now - worker.lastHeartbeat > stuckThresholdMs) {
          logger.error(`[lifecycle] Worker ${workerId} appears stuck on job ${worker.currentJobId}. Initiating stalled-job recovery.`);
          await this.routeToDeadLetterQueue(worker.queueName, worker.currentJobId, 'Job stalled for > 5 minutes', workerId);

          // Clear current job so worker can potentially recover
          this.setCurrentJob(workerId, null);
        }
      }
    }
  }

  // Dead Letter Queue Routing
  async routeToDeadLetterQueue(originalQueue: string, jobId: string, reason: string, workerName = 'workerLifecycle'): Promise<void> {
    logger.warn(`[lifecycle] Routing job ${jobId} from ${originalQueue} to dead-letter-queue. Reason: ${reason}`);

    try {
      const { getOrCreateQueue } = await import('../jobs/queueFactory.js');
      const { DeadLetterHandler } = await import('../../infrastructure/queues/DeadLetterHandler.js');
      const { dlqService } = await import('../jobs/dlq.service.js');

      const queue = getOrCreateQueue(originalQueue);
      const job = await queue.getJob(jobId);
      const error = new Error(reason);

      if (job) {
        // Persist to DeadLetterJob via DeadLetterHandler
        await DeadLetterHandler.handlePermanentFailure(originalQueue, workerName, job, error);

        // Also quarantine via dlqService if available
        try {
          const maxAttempts = Math.max(1, job.opts?.attempts || 1);
          await dlqService.quarantineJob(originalQueue, job, reason, job.attemptsMade || 1, maxAttempts, error);
        } catch (dlqErr) {
          logger.warn('[lifecycle] dlqService quarantine notice', { error: String(dlqErr) });
        }

        // Move job to failed state or discard in BullMQ
        try {
          if (typeof (job as any).moveToFailed === 'function') {
            await (job as any).moveToFailed(error, (job as any).token || '0', true);
          } else if (typeof job.discard === 'function') {
            job.discard();
          }
        } catch (moveErr) {
          logger.warn('[lifecycle] Could not move job to failed state in BullMQ', { error: String(moveErr) });
        }
      } else {
        // Fallback: If job cannot be retrieved from BullMQ, record DeadLetterJob audit document directly
        const { DeadLetterJob } = await import('../../db/models/deadLetterJob.model.js');
        await DeadLetterJob.create({
          queueName: originalQueue,
          jobId,
          workerName,
          payload: { note: 'Job object not retrieved from BullMQ queue during stalled recovery' },
          failureReason: reason,
          stackTrace: error.stack,
          retryHistory: [],
          failedAt: new Date(),
          recovered: false,
        });
        logger.info(`[lifecycle] Persisted fallback DeadLetterJob record for JobID: ${jobId}`);
      }
    } catch (err) {
      logger.error(`[lifecycle] Failed to route stalled job ${jobId} to DLQ`, err);
    }
  }

  // Initiate graceful draining
  async initiateDrain(workerId: string): Promise<DrainingProgress> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error('Worker not found');
    }

    worker.status = 'draining';

    // Pause BullMQ worker to halt pulling new jobs from the queue
    const bullWorker = this.bullWorkers.get(workerId);
    if (bullWorker) {
      try {
        await bullWorker.pause(true);
        logger.info('[lifecycle] BullMQ worker paused for draining', { workerId });
      } catch (pauseErr) {
        logger.warn('[lifecycle] Failed to pause BullMQ worker during drain', { workerId, error: String(pauseErr) });
      }
    }

    // Query real active job count from BullMQ queue
    let activeJobs = 0;
    try {
      const { getOrCreateQueue } = await import('../jobs/queueFactory.js');
      const queue = getOrCreateQueue(worker.queueName);
      if (queue && typeof queue.getActiveCount === 'function') {
        activeJobs = await queue.getActiveCount();
      } else {
        activeJobs = worker.currentJobId ? 1 : 0;
      }
    } catch {
      activeJobs = worker.currentJobId ? 1 : 0;
    }

    const progress: DrainingProgress = {
      workerId,
      activeJobs,
      maxDrainTimeMs: this.gracefulShutdownTimeout,
      startedAt: Date.now(),
      estimatedRemaining: activeJobs * 30000, // Estimate 30s per job
    };

    this.drainingWorkers.set(workerId, progress);

    logger.info('[lifecycle] Worker draining initiated', { workerId, activeJobs });

    if (activeJobs === 0) {
      await this.completeDrain(workerId);
    }

    return progress;
  }

  // Check drain progress
  checkDrainProgress(workerId: string): DrainingProgress | null {
    return this.drainingWorkers.get(workerId) || null;
  }

  // Complete drain
  async completeDrain(workerId: string): Promise<void> {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.status = 'stopped';
    }
    this.drainingWorkers.delete(workerId);

    logger.info('[lifecycle] Worker drain completed', { workerId });
  }

  // Get all worker status
  getAllWorkers(): WorkerHealth[] {
    return Array.from(this.workers.values());
  }

  // Get single worker status
  getWorker(workerId: string): WorkerHealth | undefined {
    return this.workers.get(workerId);
  }

  // Stop all workers gracefully (for shutdown)
  async gracefulShutdown(maxWaitMs = 60000): Promise<void> {
    const startTime = Date.now();

    // Initiate drain on all registered workers
    for (const workerId of this.workers.keys()) {
      try {
        await this.initiateDrain(workerId);
      } catch (err) {
        logger.warn(`[lifecycle] Error initiating drain for ${workerId}`, { error: String(err) });
      }
    }

    // Close BullMQ workers concurrently within maxWaitMs
    const closePromises: Promise<void>[] = [];
    for (const [workerId, bullWorker] of this.bullWorkers.entries()) {
      closePromises.push(
        (async () => {
          try {
            await bullWorker.close();
            await this.completeDrain(workerId);
          } catch (err) {
            logger.warn(`[lifecycle] Error closing BullMQ worker ${workerId}`, { error: String(err) });
          }
        })()
      );
    }

    // Wait for all workers to close or timeout
    const timeoutPromise = new Promise((resolve) => setTimeout(resolve, Math.max(10, maxWaitMs)));
    await Promise.race([Promise.all(closePromises), timeoutPromise]);

    // Mark remaining workers as stopped
    for (const worker of this.workers.values()) {
      worker.status = 'stopped';
    }
    this.drainingWorkers.clear();

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    logger.info('[lifecycle] Graceful shutdown completed');
  }

  // Deployment-safe queue pause
  async pauseQueueForDeploy(queueName: string): Promise<void> {
    const { getQueue } = await import('../jobs/queueFactory.js');
    const queue = getQueue(queueName);

    if (queue) {
      await queue.pause();
      logger.info('[lifecycle] Queue paused for deploy', { queueName });
    }
  }

  // Resume queue after deploy
  async resumeQueueAfterDeploy(queueName: string): Promise<void> {
    const { getQueue } = await import('../jobs/queueFactory.js');
    const queue = getQueue(queueName);

    if (queue) {
      await queue.resume();
      logger.info('[lifecycle] Queue resumed after deploy', { queueName });
    }
  }
}

// Singleton instance
export const workerRegistry = new WorkerRegistry();

// Worker lifecycle hooks for BullMQ workers
export function createWorkerLifecycleHooks(
  workerId: string,
  queueName: string,
  worker: Worker,
  registry: WorkerRegistry = workerRegistry
) {
  registry.register(workerId, queueName, worker.opts?.concurrency || 1, worker);

  return {
    onJobStart: (jobId: string) => {
      registry.setCurrentJob(workerId, jobId);
    },
    onJobComplete: () => {
      registry.setCurrentJob(workerId, null);
      registry.incrementProcessed(workerId);
    },
    onJobFailed: () => {
      registry.setCurrentJob(workerId, null);
      registry.incrementFailed(workerId);
    },
    onWorkerDrain: async () => {
      await registry.completeDrain(workerId);
    },
  };
}

// SSE connection lifecycle for deployment safety
export function createSseLifecycleManager() {
  const activeConnections = new Map<string, { connectedAt: number; lastActivity: number }>();

  return {
    registerConnection(connectionId: string): void {
      activeConnections.set(connectionId, {
        connectedAt: Date.now(),
        lastActivity: Date.now(),
      });
    },

    unregisterConnection(connectionId: string): void {
      activeConnections.delete(connectionId);
    },

    updateActivity(connectionId: string): void {
      const conn = activeConnections.get(connectionId);
      if (conn) {
        conn.lastActivity = Date.now();
      }
    },

    getActiveCount(): number {
      return activeConnections.size;
    },

    // Get connections for graceful drain
    async drainConnections(maxWaitMs = 30000): Promise<void> {
      const startTime = Date.now();

      while (activeConnections.size > 0 && Date.now() - startTime < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      logger.info('[lifecycle] SSE connections drained', {
        remaining: activeConnections.size,
      });
    },

    // Prevent new connections during deploy (optional)
    isAcceptingConnections(): boolean {
      return true;
    },
  };
}

export default workerRegistry;
