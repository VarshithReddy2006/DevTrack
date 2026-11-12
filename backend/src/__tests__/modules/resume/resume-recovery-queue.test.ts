import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../../../middleware/auth.js';
import { ResumeSession } from '../../../db/models/resumeSession.model.js';
import { WorkerFactory } from '../../../infrastructure/queues/WorkerFactory.js';
import { resumeSession } from '../../../modules/resume/upload/upload.controller.js';
import { getRedisHealth } from '../../../shared/redis/index.js';
import { startResumeUploadWorker, stopResumeUploadWorker } from '../../../workers/worker-resume-upload.js';

const { add, resumeFromCheckpoint } = vi.hoisted(() => ({
  add: vi.fn(),
  resumeFromCheckpoint: vi.fn(),
}));

vi.mock('../../../db/models/resumeSession.model.js', () => ({
  ResumeSession: { findOne: vi.fn() },
}));
vi.mock('../../../modules/resume/upload/upload.service.js', () => ({ UploadService: class {} }));
vi.mock('../../../shared/redis/index.js', () => ({ getRedisHealth: vi.fn() }));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({
  getResumeUploadQueue: () => ({ add }),
}));
vi.mock('../../../modules/resume/orchestration/ResumeProcessingOrchestrator.js', () => ({
  ResumeProcessingOrchestrator: class { resumeFromCheckpoint = resumeFromCheckpoint; },
}));
vi.mock('../../../infrastructure/queues/WorkerFactory.js', () => ({
  WorkerFactory: { createWorker: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })) },
}));

const request = { params: { id: 'resume-1' }, user: { id: 'owner-1' } } as unknown as AuthenticatedRequest;
const failedSession = {
  currentStage: 'FAILED',
  failureState: { failed: true, retryCount: 2 },
  checkpointState: { stage: 'PARSING' },
};
const ownershipFilter = { sessionId: 'resume-1', userId: 'owner-1' };
const jobData = { ...ownershipFilter, recoveryRetryCount: 2 };

async function requestRecovery(req = request) {
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  await resumeSession(req, response as unknown as Response, next);
  expect(next).not.toHaveBeenCalled();
  return response.status;
}

describe('resume recovery requests and worker dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ResumeSession.findOne).mockResolvedValue(failedSession);
    vi.mocked(getRedisHealth).mockReturnValue({
      status: 'connected', host: 'localhost', port: 6379, lastError: null, reconnectAttempts: 0,
    });
  });

  it('queues a deduplicated recovery for the owner and dispatches it through the upload worker', async () => {
    const status = await requestRecovery();
    expect(status).toHaveBeenCalledWith(202);
    expect(ResumeSession.findOne).toHaveBeenCalledWith(ownershipFilter);
    expect(add).toHaveBeenCalledWith('resume', jobData, {
      deduplication: { id: 'resume-resume-1' },
    });

    await startResumeUploadWorker();
    try {
      const [queue, process] = vi.mocked(WorkerFactory.createWorker).mock.calls[0];
      expect(queue).toBe('resume-upload');
      await process({ data: jobData, attemptsMade: 0, opts: { attempts: 3 } } as Parameters<typeof process>[0]);
      expect(resumeFromCheckpoint).toHaveBeenCalledExactlyOnceWith('resume-1', false);

      vi.mocked(ResumeSession.findOne).mockResolvedValue({
        ...failedSession, failureState: { failed: true, retryCount: 3 },
      });
      await process({ data: jobData, attemptsMade: 0, opts: { attempts: 3 } } as Parameters<typeof process>[0]);
      expect(resumeFromCheckpoint).toHaveBeenCalledTimes(1);
    } finally {
      await stopResumeUploadWorker();
    }
  });

  it('returns 404 when the session is absent from the caller’s account', async () => {
    vi.mocked(ResumeSession.findOne).mockResolvedValue(null);
    expect(await requestRecovery()).toHaveBeenCalledWith(404);
    expect(ResumeSession.findOne).toHaveBeenCalledWith(ownershipFilter);
    expect(add).not.toHaveBeenCalled();
  });

  it.each([
    { ...failedSession, currentStage: 'COMPLETED' },
    { ...failedSession, checkpointState: undefined },
  ])('returns 409 when the session cannot resume', async (session) => {
    vi.mocked(ResumeSession.findOne).mockResolvedValue(session);
    expect(await requestRecovery()).toHaveBeenCalledWith(409);
    expect(add).not.toHaveBeenCalled();
  });
});
