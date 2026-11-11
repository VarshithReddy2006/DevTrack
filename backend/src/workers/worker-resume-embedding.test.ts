import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Embedding } from '../db/models/embedding.model.js';
import { ResumeSession } from '../db/models/resumeSession.model.js';
import { EMBEDDING_VERSION } from '../modules/ai/embedding/embeddingScope.js';
import { startResumeEmbeddingWorker, stopResumeEmbeddingWorker } from './worker-resume-embedding.js';

type EmbeddingJob = { data: { sessionId: string } };
const { processor } = vi.hoisted(() => ({ processor: { run: undefined as ((job: EmbeddingJob) => Promise<void>) | undefined } }));
vi.mock('../infrastructure/queues/WorkerFactory.js', () => ({
  WorkerFactory: {
    createWorker: (_name: string, run: (job: EmbeddingJob) => Promise<void>) => {
      processor.run = run;
      return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    },
  },
}));

afterEach(async () => {
  await stopResumeEmbeddingWorker();
  processor.run = undefined;
});

describe('resume embedding worker ownership', () => {
  it('persists owned embeddings and keeps guest embeddings out of the shared collection', async () => {
    const userId = new Types.ObjectId();
    const now = new Date();
    const timestamps = { uploadedAt: now, lastUpdated: now };
    const uploadMetadata = {
      originalFilename: 'synthetic.txt', fileType: 'txt', fileSize: 24,
      uploadPath: 'synthetic.txt', uploadedAt: now, mimeType: 'text/plain',
    };
    const parsedContent = { text: 'synthetic resume content' };
    await ResumeSession.create([
      { sessionId: 'owned-resume', userId, uploadMetadata, parsedContent, timestamps },
      { sessionId: 'guest-resume', uploadMetadata, parsedContent, timestamps },
    ]);
    await startResumeEmbeddingWorker();
    await processor.run!({ data: { sessionId: 'owned-resume' } });
    await processor.run!({ data: { sessionId: 'guest-resume' } });

    expect(await Embedding.countDocuments()).toBe(1);
    expect(await Embedding.findOne().lean()).toMatchObject({
      sessionId: 'owned-resume', scope: 'user', userId, embeddingVersion: EMBEDDING_VERSION,
    });
    expect(await ResumeSession.findOne({ sessionId: 'guest-resume' }).lean()).toMatchObject({
      currentStage: 'SEMANTIC_ANALYZING',
      embeddingState: { generated: true, embeddingVersion: EMBEDDING_VERSION },
    });
  });
});
