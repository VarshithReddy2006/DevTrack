import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { createWorkerRuntime, workerDefinitions } from '../../../workers/worker-runtime.js';
import { getOrCreateQueue, closeAllQueues } from '../../../shared/jobs/queueFactory.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';

// The normal unit setup owns a Mongo replica set and simulates BullMQ delivery.
// Business processors and saved results are real; Redis behavior is covered by
// the separate CI-only worker-queues suite.
let runtime: ReturnType<typeof createWorkerRuntime>;
let userId: string;
beforeEach(async () => {
  userId = new Types.ObjectId().toHexString();
  runtime = createWorkerRuntime('all', { validate: async () => {}, connect: async () => {}, disconnect: async () => {} },
    workerDefinitions.filter(d => ['readiness-dsa', 'resume-ats'].includes(d.queueName!)));
  await runtime.start();
});
afterEach(async () => { await runtime.stop(); await closeAllQueues(); });
it('delivers a readiness-dsa job through its registry loader and saves the result', async () => {
  const job = await getOrCreateQueue('readiness-dsa').add('rebuild', { userId, platform: 'leetcode' });
  await vi.waitFor(async () => expect(await job.getState()).toBe('completed'), { timeout: 5000 });
  expect(await ReadinessDsa.findOne({ userId })).toMatchObject({ totalSolves: 0 });
});
it('delivers a resume-ats job through its registry loader and saves ATS analysis', async () => {
  const sessionId = new Types.ObjectId().toHexString();
  await ResumeProfile.create({ userId });
  await ResumeSession.create({ sessionId, userId, currentStage: 'ATS_ANALYZING',
    uploadMetadata: { originalFilename: 'fixture.txt', fileType: 'txt', fileSize: 100, mimeType: 'text/plain', uploadPath: '/fixture', uploadedAt: new Date() },
    parsedContent: { text: 'Summary\nDeveloper\nExperience\nBuilt web apps\nSkills\nTypeScript MongoDB\nEducation\nComputer Science', sections: {}, headings: [], bullets: [], links: [], metadata: {}, parsingDiagnostics: { confidence: 1, warnings: [], errors: [] } },
    timestamps: { uploadedAt: new Date(), lastUpdated: new Date() },
  });
  const job = await getOrCreateQueue('resume-ats').add('analyze', { sessionId });
  await vi.waitFor(async () => expect(await job.getState()).toBe('completed'), { timeout: 5000 });
  const session = await ResumeSession.findOne({ sessionId });
  expect(session?.atsState.analyzed).toBe(true);
  expect(session?.atsState.atsScore).toEqual(expect.any(Number));
});
