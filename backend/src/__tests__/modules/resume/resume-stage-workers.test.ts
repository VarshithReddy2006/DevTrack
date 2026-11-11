import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Types } from 'mongoose';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { SemanticAnalysis } from '../../../db/models/semanticAnalysis.model.js';
import { AIProviderAdapter } from '../../../modules/ai/provider/AIProviderAdapter.js';
import { RealEmbeddingPipeline } from '../../../modules/ai/embedding/RealEmbeddingPipeline.js';
import { UploadService } from '../../../modules/resume/upload/upload.service.js';
import { closeAllQueues, getOrCreateQueue } from '../../../shared/jobs/queueFactory.js';
import { QueueNames } from '../../../shared/jobs/types.js';
import { disconnectRedis, getRedisClient, getRedisHealth } from '../../../shared/redis/index.js';
import { eventBus } from '../../../shared/sse/index.js';
import { workerDefinitions } from '../../../workers/worker-runtime.js';

vi.unmock('bullmq');
vi.unmock('ioredis');

// Point this at a disposable Redis instance because these workers consume production queue names.
const redisUrl = process.env.DEVTRACK_RESUME_TEST_REDIS_URL;
const resumeQueues = [
  QueueNames.RESUME_UPLOAD,
  QueueNames.RESUME_ATS,
  QueueNames.RESUME_EMBEDDING,
  QueueNames.RESUME_SEMANTIC,
  QueueNames.RESUME_RECOMMENDATION,
];

describe.skipIf(!redisUrl)('resume upload with real BullMQ workers', () => {
  const stopWorkers: (() => Promise<unknown>)[] = [];
  const upload = new UploadService();

  beforeAll(async () => {
    vi.stubEnv('REDIS_URL', redisUrl);
    await getRedisClient().ping();
    await vi.waitFor(() => expect(getRedisHealth().status).toBe('connected'));

    for (const name of resumeQueues) {
      const definition = workerDefinitions.find(worker => worker.queueName === name);
      if (!definition) throw new Error(`Missing worker for ${name}`);
      const { start, stop } = await definition.load();
      await start();
      stopWorkers.push(async () => stop());
    }
  });

  afterAll(async () => {
    await Promise.allSettled(stopWorkers.map(stop => stop()));
    try {
      await closeAllQueues();
    } finally {
      eventBus.shutdown();
      await disconnectRedis();
      vi.unstubAllEnvs();
    }
  });

  async function submitResume() {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'resume-stage-'));
    const filePath = path.join(directory, 'resume.txt');
    const text = 'Sam Engineer\nSummary: Software engineer\nExperience: Built and tested a service.\nSkills: TypeScript, Docker\nEducation: Computer Science';
    try {
      await fs.writeFile(filePath, text);
      return await upload.processUpload({
        path: filePath, filename: 'resume.txt', originalname: 'resume.txt',
        mimetype: 'text/plain', size: Buffer.byteLength(text),
      } as Express.Multer.File, new Types.ObjectId().toString());
    } finally {
      await fs.unlink(filePath).catch(() => {});
      await fs.rmdir(directory);
    }
  }

  function mockProvider(malformed = false) {
    vi.mocked(AIProviderAdapter.generateResponse).mockImplementation(async request => ({
      content: JSON.stringify(request.responseSchemaVersion === 'resume-skills-v1'
        ? { skills: malformed ? [123] : ['TypeScript', 'Docker'] }
        : {
          extractedSkills: { languages: ['TypeScript'], frameworks: [], databases: [], cloudTools: [], devOpsTools: ['Docker'], aiMlTools: [] },
          experienceSignals: { yearsOfExperience: 1, engineeringDepth: 4, projectComplexity: 4, leadershipIndicators: 2, productionExposure: 3 },
          roleAlignment: { backend: 60, frontend: 35, fullstack: 40, ml: 10, devops: 40 },
          weaknesses: [], strengths: ['Built and tested a service'],
          semanticSummary: 'Software engineer', confidenceScore: malformed ? 101 : 80,
        }),
      provider: 'openai', model: 'test-provider', tokensUsed: 0, latency: 0, cached: false, fallbackTriggered: false,
    }));
  }

  it.each([false, true])('dispatches all stages and persists provider diagnostics (invalid output: %s)', async malformed => {
    mockProvider(malformed);
    const result = await submitResume();
    expect(result.status).toBe('UPLOADED');

    await vi.waitFor(async () => {
      const session = await ResumeSession.findOne({ sessionId: result.sessionId }).lean();
      expect(session?.currentStage).toBe(malformed ? 'DEGRADED' : 'COMPLETED');
      expect(session?.atsState.analyzed).toBe(true);
      expect(session?.embeddingState.generated).toBe(true);
      expect(session?.recommendationState.generated).toBe(true);
      expect(session?.replayState.generated).toBe(true);
      expect(session?.parsedContent.metadata.extractedSkills).toEqual(['TypeScript', 'Docker']);
      expect(session?.runtimeEvents.at(-1)?.status).toBe(malformed ? 'degraded' : 'completed');
      await expect(fs.stat(result.uploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }, { timeout: 10_000 });

    for (const [queue, stage] of [
      [QueueNames.RESUME_ATS, 'ATS_ANALYZING'],
      [QueueNames.RESUME_EMBEDDING, 'EMBEDDING'],
      [QueueNames.RESUME_SEMANTIC, 'SEMANTIC_ANALYZING'],
      [QueueNames.RESUME_RECOMMENDATION, 'RECOMMENDING'],
    ]) {
      const job = await getOrCreateQueue(queue).getJob(`${result.sessionId}--${stage}--0`);
      expect(await job?.getState()).toBe('completed');
    }

    const analysis = await SemanticAnalysis.findOne({ sessionId: result.sessionId }).lean();
    if (malformed) {
      expect(analysis).toBeNull();
      const status = await upload.getSessionStatus(result.sessionId);
      expect(status?.errors[0]).toContain('invalid structured analysis');
    } else {
      expect(analysis?.provenance).toMatchObject({ provider: 'openai', model: 'test-provider' });
    }
  }, 15_000);

  it('persists exhausted embedding failures and recovers from the committed checkpoint', async () => {
    mockProvider();
    const embed = vi.spyOn(RealEmbeddingPipeline.prototype, 'processAndStore')
      .mockRejectedValue(new Error('Embedding provider timeout'));
    const result = await submitResume();
    try {
      await vi.waitFor(async () => {
        const session = await ResumeSession.findOne({ sessionId: result.sessionId }).lean();
        expect(session?.failureState).toMatchObject({
          failed: true, failureStage: 'EMBEDDING', failureReason: 'Embedding provider timeout', retryCount: 1,
        });
        expect(session?.processingHistory.at(-1)).toMatchObject({ stage: 'EMBEDDING', status: 'failed' });
        expect(session?.runtimeEvents.at(-1)?.errors).toEqual(['Embedding provider timeout']);
        expect(session?.checkpointState?.stage).toBe('ATS_ANALYZING');
        const job = await getOrCreateQueue(QueueNames.RESUME_EMBEDDING).getJob(`${result.sessionId}--EMBEDDING--0`);
        expect(await job?.getState()).toBe('failed');
      }, { timeout: 10_000 });
      expect(embed).toHaveBeenCalledTimes(3);
      expect(await getOrCreateQueue(QueueNames.RESUME_SEMANTIC).getJob(`${result.sessionId}--SEMANTIC_ANALYZING--0`)).toBeUndefined();

      embed.mockRestore();
      const failed = await ResumeSession.findOne({ sessionId: result.sessionId }).orFail();
      await getOrCreateQueue(QueueNames.RESUME_UPLOAD).add('resume', {
        sessionId: result.sessionId,
        userId: failed.userId?.toString(),
        recoveryRetryCount: failed.failureState.retryCount,
      });
      await vi.waitFor(async () => {
        const status = await upload.getSessionStatus(result.sessionId);
        expect(status?.currentStage).toBe('COMPLETED');
        const job = await getOrCreateQueue(QueueNames.RESUME_EMBEDDING).getJob(`${result.sessionId}--EMBEDDING--1`);
        expect(await job?.getState()).toBe('completed');
        await expect(fs.stat(result.uploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
      }, { timeout: 10_000 });
    } finally {
      embed.mockRestore();
      await fs.unlink(result.uploadPath).catch(() => {});
    }
  }, 25_000);
});
