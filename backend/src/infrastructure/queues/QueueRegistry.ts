// src/infrastructure/queues/QueueRegistry.ts
import { Queue } from 'bullmq';
import { getRedisClient } from '../../shared/redis/index.js';
import { logger } from '../../shared/logger.js';
import { RetryPolicy } from './RetryPolicy.js';
import { QueueNames } from '../../shared/jobs/types.js';

interface QueueEntry {
  queue: Queue;
  name: string;
}

export class QueueRegistry {
  private static registry = new Map<string, QueueEntry>();

  static createQueueConfig(defaultJobOptions?: Record<string, unknown>) {
    return {
      connection: getRedisClient(),
      defaultJobOptions: {
        attempts: RetryPolicy.MAX_ATTEMPTS,
        backoff: RetryPolicy.getStandardBackoff(),
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
        ...defaultJobOptions,
      },
    };
  }

  static getOrCreateQueue(name: string): Queue {
    const existing = this.registry.get(name);
    if (existing) return existing.queue;

    logger.info(`[QueueRegistry] Creating queue: ${name}`);

    const queue = new Queue(name, this.createQueueConfig());
    this.registry.set(name, { queue, name });
    return queue;
  }

  static getQueue(name: string): Queue | undefined {
    const existing = this.registry.get(name);
    if (existing) return existing.queue;

    const isKnown = Object.values(QueueNames).includes(name as any);
    if (isKnown) {
      return this.getOrCreateQueue(name);
    }
    return undefined;
  }

  static getAllQueues(): Queue[] {
    for (const name of Object.values(QueueNames)) {
      this.getOrCreateQueue(name);
    }
    return Array.from(this.registry.values()).map((e) => e.queue);
  }

  static async closeAllQueues(): Promise<void> {
    const queues = Array.from(this.registry.values()).map((e) => e.queue);
    await Promise.all(queues.map((q) => q.close()));
    this.registry.clear();
    logger.info('[QueueRegistry] All queues closed');
  }
}
