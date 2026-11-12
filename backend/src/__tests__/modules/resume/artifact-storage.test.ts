import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';

const queue = vi.hoisted(() => ({ add: vi.fn(), processor: vi.fn() }));
vi.mock('../../../shared/redis/index.js', () => ({
  getRedisHealth: () => ({ status: 'connected' }),
}));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({
  getResumeUploadQueue: () => ({ add: queue.add }),
}));
vi.mock('../../../infrastructure/queues/WorkerFactory.js', () => ({
  WorkerFactory: {
    createWorker: (_name: string, processor: unknown) => {
      queue.processor(processor);
      return { on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    },
  },
}));
vi.mock('../../../modules/resume/orchestration/ResumeProcessingOrchestrator.js', () => ({
  ResumeProcessingOrchestrator: class {
    async startProcessing(sessionId: string) {
      const session = await ResumeSession.findOne({ sessionId }).orFail();
      const { artifactStorage } = await import('../../../modules/resume/upload/artifact-storage.js');
      const reference = await artifactStorage.readPath(session.uploadMetadata.uploadPath);
      const parsedText = await readFile(reference, 'utf8');
      await ResumeSession.updateOne({ sessionId }, {
        $set: { currentStage: 'COMPLETED', 'parsedContent.text': parsedText },
      });
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

it('hands an upload to the worker through the configured shared directory and cleans it up on completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devtrack-artifact-'));
  vi.stubEnv('UPLOAD_DIR', root);
  const { UploadService } = await import('../../../modules/resume/upload/upload.service.js');
  const { startResumeUploadWorker, stopResumeUploadWorker } = await import('../../../workers/worker-resume-upload.js');
  const temporaryPath = path.join(root, 'staged.txt');
  const content = 'Resume text from the upload API';

  try {
    await writeFile(temporaryPath, content);
    const uploaded = await new UploadService().processUpload({
      path: temporaryPath, originalname: 'resume.txt', filename: 'staged.txt', mimetype: 'text/plain', size: content.length,
    } as Express.Multer.File);

    expect(uploaded.uploadPath).toBe(path.join(root, 'raw', uploaded.sessionId + '-resume.txt'));
    await expect(readFile(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(queue.add).toHaveBeenCalledWith('process', expect.objectContaining({
      sessionId: uploaded.sessionId, filePath: uploaded.uploadPath,
    }));

    await startResumeUploadWorker();
    const processJob = queue.processor.mock.lastCall?.[0];
    const job = { data: queue.add.mock.lastCall?.[1], attemptsMade: 0, opts: { attempts: 3 } };
    await processJob(job);
    await processJob(job); // Redelivery uses persisted completion and does not parse a deleted file.
    const session = await ResumeSession.findOne({ sessionId: uploaded.sessionId }).orFail();
    expect(session).toMatchObject({ currentStage: 'COMPLETED', parsedContent: { text: content } });
    await expect(readFile(uploaded.uploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await stopResumeUploadWorker();
    await rm(root, { recursive: true, force: true });
  }
});

it('supports legacy reads and quarantines only files owned by the configured storage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'devtrack-artifact-'));
  const { DirectoryArtifactStorage } = await import('../../../modules/resume/upload/artifact-storage.js');
  const storage = new DirectoryArtifactStorage(root);
  const legacy = path.join(root, 'legacy.txt');
  const temporaryPath = path.join(root, 'staged.txt');
  try {
    await writeFile(legacy, 'old');
    await writeFile(temporaryPath, 'new');
    await expect(storage.store(temporaryPath, '../escaped.txt')).rejects.toThrow('Invalid resume artifact filename');
    const artifact = await storage.store(temporaryPath, 'resume.txt');
    await storage.move(artifact, 'failed');
    await storage.move(artifact, 'failed');
    await expect(readFile(path.join(root, 'failed', 'resume.txt'), 'utf8')).resolves.toBe('new');
    await expect(readFile(artifact)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(storage.readPath(legacy)).resolves.toBe(legacy);
    await storage.remove(legacy);
    await expect(readFile(legacy, 'utf8')).resolves.toBe('old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
