// src/modules/ml/serving/InferenceQueueManager.ts
// Priority queue for inference requests with batching, timeout, backpressure.

import { logger } from '../../../shared/logger.js';
import type { InferenceRequest, InferenceResult, InferencePriority } from '../types.js';

interface QueuedRequest {
  request: InferenceRequest;
  resolve: (result: InferenceResult) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  priority: number;
}

/**
 * InferenceQueueManager
 *
 * Priority queue for ML inference with:
 * - Priority-based scheduling (critical > high > normal > low)
 * - Request batching for throughput optimization
 * - Timeout enforcement
 * - Backpressure when queue depth exceeds threshold
 * - FIFO within same priority level
 */
export class InferenceQueueManager {
  private queue: QueuedRequest[] = [];
  private activeBatch: QueuedRequest[] | null = null;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private idleListeners = new Set<() => void>();
  private shutdownPromise: Promise<void> | undefined;
  private maxQueueDepth: number;
  private batchSize: number;
  private processInterval: number;
  private processor: ((requests: InferenceRequest[]) => Promise<InferenceResult[]>) | null = null;

  // Metrics
  private totalEnqueued: number = 0;
  private totalProcessed: number = 0;
  private totalDropped: number = 0;
  private totalTimeouts: number = 0;

  constructor(config?: {
    maxQueueDepth?: number;
    batchSize?: number;
    processIntervalMs?: number;
  }) {
    this.maxQueueDepth = config?.maxQueueDepth ?? 100;
    this.batchSize = config?.batchSize ?? 8;
    this.processInterval = config?.processIntervalMs ?? 50;
    logger.info('[InferenceQueueManager] Initialized', {
      maxQueueDepth: this.maxQueueDepth,
      batchSize: this.batchSize,
    });
  }

  /**
   * Set the batch processor function.
   */
  setProcessor(processor: (requests: InferenceRequest[]) => Promise<InferenceResult[]>): void {
    this.processor = processor;
    void this.processBatch();
  }

  /**
   * Enqueue an inference request. Returns promise that resolves with result.
   */
  async enqueue(request: InferenceRequest): Promise<InferenceResult> {
    if (this.shutdownPromise) {
      throw new Error('Inference queue is shutting down');
    }

    // Backpressure check
    if (this.queue.length >= this.maxQueueDepth) {
      this.totalDropped++;
      logger.warn(`[InferenceQueueManager] Queue full (${this.queue.length}), dropping request ${request.requestId}`);
      throw new Error('Inference queue full — backpressure applied');
    }

    this.totalEnqueued++;

    return new Promise<InferenceResult>((resolve, reject) => {
      const priorityValue = this.priorityToNumber(request.priority);

      const item: QueuedRequest = {
        request,
        resolve,
        reject,
        priority: priorityValue,
        timeoutHandle: setTimeout(() => {
          const index = this.queue.indexOf(item);
          if (index === -1) return;

          this.queue.splice(index, 1);
          this.totalTimeouts++;
          reject(new Error(`Inference request ${request.requestId} timed out after ${request.timeout}ms`));
          this.notifyIfIdle();
        }, request.timeout),
      };

      // Insert after requests of equal priority to preserve FIFO.
      let first = 0;
      let last = this.queue.length;
      while (first < last) {
        const middle = Math.floor((first + last) / 2);
        if (this.queue[middle].priority >= item.priority) {
          first = middle + 1;
        } else {
          last = middle;
        }
      }
      this.queue.splice(first, 0, item);
      void this.processBatch();
    });
  }

  /**
   * Get current queue depth.
   */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Get queue metrics.
   */
  getMetrics(): {
    queueDepth: number;
    totalEnqueued: number;
    totalProcessed: number;
    totalDropped: number;
    totalTimeouts: number;
  } {
    return {
      queueDepth: this.queue.length,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalDropped: this.totalDropped,
      totalTimeouts: this.totalTimeouts,
    };
  }

  /**
   * Wait for pending and active requests to finish. A deadline only bounds the wait.
   */
  async drain(maxWaitMs?: number): Promise<void> {
    if (!this.activeBatch && this.queue.length === 0) return;

    await new Promise<void>((resolve, reject) => {
      const onIdle = () => {
        clearTimeout(deadline);
        this.idleListeners.delete(onIdle);
        resolve();
      };
      const deadline = maxWaitMs === undefined ? undefined : setTimeout(() => {
        this.idleListeners.delete(onIdle);
        reject(new Error('Inference queue drain timed out'));
      }, maxWaitMs);
      this.idleListeners.add(onIdle);
    });
  }

  /**
   * Stop accepting requests and reject unfinished work if the drain deadline expires.
   */
  shutdown(maxWaitMs = 5_000): Promise<void> {
    this.shutdownPromise ??= this.drain(maxWaitMs).catch((error: Error) => {
      for (const item of this.queue.splice(0)) {
        clearTimeout(item.timeoutHandle);
        item.reject(error);
      }
      for (const item of this.activeBatch ?? []) {
        item.reject(error);
      }
      this.activeBatch = null;
      this.notifyIfIdle();
    });
    return this.shutdownPromise;
  }

  private notifyIfIdle(): void {
    if (this.activeBatch || this.queue.length > 0) return;
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    for (const listener of this.idleListeners) listener();
  }

  private async processBatch(): Promise<void> {
    if (this.activeBatch || this.batchTimer !== undefined || !this.processor || this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.batchSize);
    if (batch.length === 0) return;
    this.activeBatch = batch;
    for (const item of batch) clearTimeout(item.timeoutHandle);

    try {
      const results = await this.processor(batch.map(item => item.request));
      if (this.activeBatch !== batch) return;

      for (const [index, item] of batch.entries()) {
        this.totalProcessed++;
        if (results[index]) {
          item.resolve(results[index]);
        } else {
          item.reject(new Error('No result returned for request'));
        }
      }
    } catch (error) {
      if (this.activeBatch !== batch) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const item of batch) item.reject(failure);
    } finally {
      if (this.activeBatch === batch) {
        this.activeBatch = null;
        if (this.queue.length > 0) {
          this.batchTimer = setTimeout(() => {
            this.batchTimer = undefined;
            void this.processBatch();
          }, this.processInterval);
        } else {
          this.notifyIfIdle();
        }
      }
    }
  }

  private priorityToNumber(priority: InferencePriority): number {
    switch (priority) {
      case 'critical': return 4;
      case 'high': return 3;
      case 'normal': return 2;
      case 'low': return 1;
      default: return 2;
    }
  }
}
