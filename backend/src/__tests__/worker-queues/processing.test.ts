import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Redis from 'ioredis';
import type { Queue, QueueEvents, QueueOptions, WorkerOptions } from 'bullmq';

const state = vi.hoisted(() => ({ connection: undefined as Redis | undefined, prefix: '' }));
vi.mock('../../shared/redis/index.js', () => ({
  getRedisClient: () => state.connection!, getRedisConnection: () => state.connection!,
}));
vi.mock('../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('bullmq', async () => {
  const actual = await vi.importActual<typeof import('bullmq')>('bullmq');
  // Only namespace injection is substituted. Real BullMQ processors, Redis Lua,
  // locks and completion events execute against the supplied test Redis.
  return { ...actual,
    Worker: class extends actual.Worker {
      constructor(name: string, processor: any, options: WorkerOptions) { super(name, processor, { ...options, prefix: state.prefix }); }
    },
    Queue: class extends actual.Queue {
      constructor(name: string, options: QueueOptions) { super(name, { ...options, prefix: state.prefix }); }
    },
  };
});

const live = process.env.WORKER_TEST_REDIS_URL ? describe : describe.skip;
live('registered production consumers with real Redis and owned MongoDB', () => {
  let mongo: MongoMemoryServer | undefined;
  let runtime: ReturnType<typeof import('../../workers/worker-runtime.js')['createWorkerRuntime']> | undefined;
  let queueFactory: typeof import('../../shared/jobs/queueFactory.js');
  const queues: Queue[] = [];
  const events: QueueEvents[] = [];
  let sessionId: string;
  let userId: string;
  beforeAll(async () => {
    if (process.env.MONGODB_URI) throw new Error('Unset MONGODB_URI: this suite provisions its own database');
    state.prefix = `worker-test-${randomUUID()}`;
    state.connection = new Redis(process.env.WORKER_TEST_REDIS_URL!, {
      maxRetriesPerRequest: null, connectTimeout: 2000, retryStrategy: () => null, lazyConnect: true,
    });
    await state.connection.connect(); await state.connection.ping();
    mongo = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
    await mongoose.connect(mongo.getUri());
    userId = new mongoose.Types.ObjectId().toHexString(); sessionId = randomUUID();
    const { ResumeProfile } = await import('../../db/models/resumeProfile.model.js');
    const { ResumeSession } = await import('../../db/models/resumeSession.model.js');
    await ResumeProfile.create({ userId });
    await ResumeSession.create({ sessionId, userId, currentStage: 'ATS_ANALYZING',
      uploadMetadata: { originalFilename: 'fixture.txt', fileType: 'txt', fileSize: 100, mimeType: 'text/plain', uploadPath: '/fixture', uploadedAt: new Date() },
      parsedContent: { text: 'Summary\nSoftware developer.\nExperience\nBuilt web applications.\nSkills\nTypeScript Python MongoDB\nEducation\nComputer Science', sections: {}, headings: [], bullets: [], links: [], metadata: {}, parsingDiagnostics: { confidence: 1, warnings: [], errors: [] } },
      timestamps: { uploadedAt: new Date(), lastUpdated: new Date() },
    });
    const { createWorkerRuntime, workerDefinitions } = await import('../../workers/worker-runtime.js');
    const selected = workerDefinitions.filter(d => ['readiness-dsa', 'resume-ats'].includes(d.queueName!));
    expect(selected).toHaveLength(2);
    runtime = createWorkerRuntime('all', { validate: async () => {}, connect: async () => {}, disconnect: async () => {} }, selected);
    await runtime.start();
    queueFactory = await import('../../shared/jobs/queueFactory.js');
    const { QueueEvents } = await import('bullmq');
    for (const name of ['readiness-dsa', 'resume-ats']) {
      queues.push(queueFactory.getOrCreateQueue(name));
      const listener = new QueueEvents(name, { connection: state.connection, prefix: state.prefix });
      await listener.waitUntilReady(); events.push(listener);
    }
  }, 30000);
  afterAll(async () => {
    try { await runtime?.stop(); }
    finally {
      await Promise.all(events.map(event => event.close()));
      // These queues use an unguessable per-run prefix, never application keys.
      await Promise.all(queues.map(queue => queue.obliterate({ force: true })));
      await queueFactory?.closeAllQueues();
      await mongoose.disconnect(); await mongo?.stop(); state.connection?.disconnect();
    }
  });
  it('processes readiness-dsa and persists a readiness result', async () => {
    const job = await queues[0].add('rebuild', { userId, platform: 'leetcode' }, { attempts: 1 });
    await job.waitUntilFinished(events[0], 15000);
    const { ReadinessDsa } = await import('../../db/models/readinessDsa.model.js');
    expect(await ReadinessDsa.findOne({ userId })).toMatchObject({ totalSolves: 0 });
  });
  it('processes resume-ats and persists completed ATS analysis', async () => {
    const job = await queues[1].add('analyze', { sessionId }, { attempts: 1 });
    await job.waitUntilFinished(events[1], 15000);
    const { ResumeSession } = await import('../../db/models/resumeSession.model.js');
    const session = await ResumeSession.findOne({ sessionId });
    expect(session?.atsState.analyzed).toBe(true); expect(session?.atsState.atsScore).toEqual(expect.any(Number));
  });
});
