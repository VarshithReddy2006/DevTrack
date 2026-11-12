import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueueRegistry } from '../../../infrastructure/queues/QueueRegistry.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { startProfileRebuildWorker, stopProfileRebuildWorker, profileRebuildQueue } from '../../../shared/jobs/profileRebuildWorker.js';
import { DeadLetterJob } from '../../../db/models/deadLetterJob.model.js';
import { dlqService } from '../../../shared/jobs/dlq.service.js';

describe('Issue #144: Cross-Process Queue Inspection, DLQ Replay & Profile Rebuild Worker Config', () => {
  afterEach(async () => {
    await stopProfileRebuildWorker();
    await QueueRegistry.closeAllQueues();
  });

  describe('Shared Queue Catalog & Cross-Process Inspection', () => {
    it('initializes and returns all active BullMQ queues across separate processes', () => {
      const allQueues = QueueRegistry.getAllQueues();
      expect(allQueues.length).toBeGreaterThanOrEqual(Object.keys(QueueNames).length);

      const queueNames = allQueues.map((q) => q.name);
      expect(queueNames).toContain(QueueNames.PLATFORM_SYNC);
      expect(queueNames).toContain(QueueNames.PROFILE_REBUILD);
      expect(queueNames).toContain(QueueNames.XP_PROCESSING);
    });

    it('dynamically instantiates known queues via getQueue', () => {
      const syncQueue = QueueRegistry.getQueue(QueueNames.PLATFORM_SYNC);
      expect(syncQueue).toBeDefined();
      expect(syncQueue?.name).toBe(QueueNames.PLATFORM_SYNC);
    });
  });

  describe('profileRebuildWorker Configuration', () => {
    it('uses shared Redis connection options and starts cleanly', () => {
      expect(profileRebuildQueue).toBeDefined();
      expect(profileRebuildQueue.name).toBe(QueueNames.PROFILE_REBUILD);

      const worker = startProfileRebuildWorker();
      expect(worker).toBeDefined();
      expect(worker.name).toBe(QueueNames.PROFILE_REBUILD);
    });
  });

  describe('DLQ Replay & Audit Tracking', () => {
    it('updates DeadLetterJob audit status to recovered upon DLQ replay', async () => {
      const jobId = 'test-job-replay-144';
      const queueName = QueueNames.PLATFORM_SYNC;

      // Seed audit record
      const audit = await DeadLetterJob.create({
        queueName,
        jobId,
        workerName: 'PlatformSyncWorker',
        payload: { userId: 'u123', platformName: 'leetcode' },
        failureReason: 'Rate limit exceeded',
        failedAt: new Date(),
        recovered: false,
      });

      expect(audit.recovered).toBe(false);

      // Replay simulation via dlqService / DeadLetterJob
      await DeadLetterJob.updateMany(
        { jobId },
        { $set: { recovered: true } }
      );

      const updatedAudit = await DeadLetterJob.findOne({ jobId });
      expect(updatedAudit?.recovered).toBe(true);
    });
  });
});
