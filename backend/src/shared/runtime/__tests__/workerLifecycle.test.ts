// src/shared/runtime/__tests__/workerLifecycle.test.ts

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { WorkerRegistry, createWorkerLifecycleHooks } from '../workerLifecycle.js';
import { DeadLetterJob } from '../../../db/models/deadLetterJob.model.js';
import type { Worker, Queue, Job } from 'bullmq';

// Mock Queue and Jobs
const mockJobs = new Map<string, any>();
const mockQueue = {
  getJob: vi.fn(async (jobId: string) => mockJobs.get(jobId) || null),
  getActiveCount: vi.fn(async () => 2),
  pause: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
};

vi.mock('../../jobs/queueFactory.js', () => ({
  getOrCreateQueue: () => mockQueue,
  getQueue: () => mockQueue,
}));

vi.mock('../../jobs/dlq.service.js', () => ({
  dlqService: {
    quarantineJob: vi.fn(async () => {}),
  },
}));

describe('WorkerRegistry - Stalled-Job DLQ Routing, Drain & Graceful Shutdown', () => {
  let registry: WorkerRegistry;

  beforeAll(async () => {
    await DeadLetterJob.init();
  });

  beforeEach(async () => {
    registry = new WorkerRegistry();
    mockJobs.clear();
    vi.clearAllMocks();
    await DeadLetterJob.deleteMany({});
  });

  const createMockBullWorker = (overrides?: Partial<Worker>): Worker => {
    return {
      opts: { concurrency: 4 },
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      ...overrides,
    } as unknown as Worker;
  };

  const createMockJob = (id: string, data: Record<string, unknown> = { fileId: 'doc-123' }): Job => {
    return {
      id,
      name: 'resume-processing',
      data,
      opts: { attempts: 3 },
      attemptsMade: 1,
      stacktrace: ['Error: stuck execution'],
      moveToFailed: vi.fn(async () => {}),
      discard: vi.fn(() => {}),
    } as unknown as Job;
  };

  describe('Stalled Job DLQ Routing', () => {
    it('routes a stalled BullMQ job to DeadLetterJob and moves job to failed state', async () => {
      const jobId = 'job-stalled-999';
      const mockJob = createMockJob(jobId, { candidateId: 'cand-456', test: true });
      mockJobs.set(jobId, mockJob);

      await registry.routeToDeadLetterQueue('resume-intelligence', jobId, 'Job stalled for > 5 minutes', 'worker-ats-1');

      // 1. Verify DeadLetterJob document created in MongoDB
      const dlqRecord = await DeadLetterJob.findOne({ jobId });
      expect(dlqRecord).not.toBeNull();
      expect(dlqRecord?.queueName).toBe('resume-intelligence');
      expect(dlqRecord?.workerName).toBe('worker-ats-1');
      expect(dlqRecord?.failureReason).toBe('Job stalled for > 5 minutes');
      expect(dlqRecord?.payload).toMatchObject({ candidateId: 'cand-456' });

      // 2. Verify moveToFailed was called on the BullMQ job
      expect(mockJob.moveToFailed).toHaveBeenCalled();
    });

    it('creates a fallback DeadLetterJob record when job object is not found in BullMQ storage', async () => {
      const missingJobId = 'job-missing-000';

      await registry.routeToDeadLetterQueue('dsa-sync', missingJobId, 'Job stalled for > 5 minutes', 'worker-dsa-1');

      const dlqRecord = await DeadLetterJob.findOne({ jobId: missingJobId });
      expect(dlqRecord).not.toBeNull();
      expect(dlqRecord?.queueName).toBe('dsa-sync');
      expect(dlqRecord?.failureReason).toBe('Job stalled for > 5 minutes');
      expect(dlqRecord?.payload).toHaveProperty('note');
    });

    it('detects stuck worker in checkWorkerHealth and triggers recovery automatically', async () => {
      const workerId = 'worker-ats-2';
      const jobId = 'job-stuck-heartbeat';
      const mockJob = createMockJob(jobId, { prompt: 'evaluate resume' });
      mockJobs.set(jobId, mockJob);

      registry.register(workerId, 'resume-ats', 2);
      registry.updateStatus(workerId, 'running');
      registry.setCurrentJob(workerId, jobId);

      // Simulate heartbeat timestamp 6 minutes in the past
      const pastTime = Date.now() - 360000;
      const worker = registry.getWorker(workerId);
      if (worker) {
        worker.lastHeartbeat = pastTime;
      }

      await registry.checkWorkerHealth(300000);

      // Stalled recovery should have routed job to DLQ and cleared currentJobId
      const dlqRecord = await DeadLetterJob.findOne({ jobId });
      expect(dlqRecord).not.toBeNull();
      expect(registry.getWorker(workerId)?.currentJobId).toBeNull();
    });
  });

  describe('Worker Draining & Active Job Counting', () => {
    it('pauses registered BullMQ worker and queries real active job count from queue', async () => {
      const bullWorker = createMockBullWorker();
      const workerId = 'worker-drain-1';
      mockQueue.getActiveCount.mockResolvedValueOnce(5);

      registry.register(workerId, 'resume-ats', 4, bullWorker);
      const progress = await registry.initiateDrain(workerId);

      // 1. BullMQ worker was paused
      expect(bullWorker.pause).toHaveBeenCalledWith(true);

      // 2. Active jobs queried from queue
      expect(progress.activeJobs).toBe(5);
      expect(registry.getWorker(workerId)?.status).toBe('draining');
      expect(registry.checkDrainProgress(workerId)).not.toBeNull();
    });

    it('completes drain immediately if active job count is 0', async () => {
      const bullWorker = createMockBullWorker();
      const workerId = 'worker-drain-empty';
      mockQueue.getActiveCount.mockResolvedValueOnce(0);

      registry.register(workerId, 'notifications', 1, bullWorker);
      const progress = await registry.initiateDrain(workerId);

      expect(progress.activeJobs).toBe(0);
      expect(registry.getWorker(workerId)?.status).toBe('stopped');
      expect(registry.checkDrainProgress(workerId)).toBeNull();
    });
  });

  describe('Graceful Shutdown', () => {
    it('initiates drain and awaits close() on all registered BullMQ workers', async () => {
      const bullWorker1 = createMockBullWorker();
      const bullWorker2 = createMockBullWorker();

      registry.register('worker-1', 'queue-1', 2, bullWorker1);
      registry.register('worker-2', 'queue-2', 2, bullWorker2);

      await registry.gracefulShutdown(500);

      // Both BullMQ workers should have pause and close called
      expect(bullWorker1.close).toHaveBeenCalled();
      expect(bullWorker2.close).toHaveBeenCalled();

      // All workers in registry should be marked as stopped
      const all = registry.getAllWorkers();
      expect(all.every((w) => w.status === 'stopped')).toBe(true);
    });
  });

  describe('Lifecycle Hooks Integration', () => {
    it('createWorkerLifecycleHooks tracks job start, completion, failure, and drain', async () => {
      const bullWorker = createMockBullWorker();
      const hooks = createWorkerLifecycleHooks('worker-hooked', 'queue-test', bullWorker, registry);

      // Start job
      hooks.onJobStart('job-active-1');
      expect(registry.getWorker('worker-hooked')?.currentJobId).toBe('job-active-1');

      // Complete job
      hooks.onJobComplete();
      expect(registry.getWorker('worker-hooked')?.currentJobId).toBeNull();
      expect(registry.getWorker('worker-hooked')?.jobsProcessed).toBe(1);

      // Failed job
      hooks.onJobStart('job-active-2');
      hooks.onJobFailed();
      expect(registry.getWorker('worker-hooked')?.jobsFailed).toBe(1);

      // Drain completion
      await hooks.onWorkerDrain();
      expect(registry.getWorker('worker-hooked')?.status).toBe('stopped');
    });
  });
});
