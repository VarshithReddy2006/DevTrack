import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  scheduler: vi.fn(), worker: vi.fn(), on: vi.fn(), close: vi.fn(),
}));
vi.mock('../../../shared/jobs/queueFactory.js', () => ({ getOrCreateQueue: () => ({ upsertJobScheduler: mocks.scheduler }) }));
vi.mock('../../../shared/jobs/dlq.service.js', () => ({ createDlqWorker: mocks.worker }));
vi.mock('../../../shared/redis/index.js', () => ({ getRedisClient: () => ({}) }));
import { createInterviewGuardWorker } from '../../../modules/interview/workers/interviewGuard.worker.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scheduler.mockResolvedValue(undefined); mocks.close.mockResolvedValue(undefined);
  mocks.worker.mockReturnValue({ on: mocks.on, close: mocks.close });
});
describe('bound interview guard maintenance lifecycle', () => {
  it('creates one shared one-minute scheduler and consumer, sweeps on startup and on jobs, and drains once', async () => {
    const sweep = vi.fn().mockResolvedValue(undefined);
    const lifecycle = createInterviewGuardWorker({ sweep });
    await Promise.all([lifecycle.start(), lifecycle.start()]);
    expect(mocks.scheduler).toHaveBeenCalledExactlyOnceWith('interview-guard-sweep', { every: 60000 }, {
      name: 'interview.guard.sweep', data: {}, opts: { attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
    });
    expect(mocks.worker).toHaveBeenCalledOnce();
    expect(mocks.worker).toHaveBeenCalledWith('interview-guard', expect.any(Function), expect.objectContaining({ concurrency: 1 }));
    expect(sweep).toHaveBeenCalledOnce();
    await mocks.worker.mock.calls[0][1]();
    expect(sweep).toHaveBeenCalledTimes(2);
    await Promise.all([lifecycle.stop(), lifecycle.stop()]);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('propagates sweep errors to the shared retry/DLQ processor', async () => {
    const sweep = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('delivery failed'));
    const lifecycle = createInterviewGuardWorker({ sweep });
    await lifecycle.start();
    await expect(mocks.worker.mock.calls[0][1]()).rejects.toThrow('delivery failed');
    await lifecycle.stop();
  });
  it('permits cleanup after startup catch-up fails', async () => {
    const lifecycle = createInterviewGuardWorker({ sweep: vi.fn().mockRejectedValue(new Error('startup failed')) });
    await expect(lifecycle.start()).rejects.toThrow('startup failed');
    await lifecycle.stop();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('can retry scheduler initialization without leaking a consumer', async () => {
    mocks.scheduler.mockRejectedValueOnce(new Error('Redis unavailable'));
    const lifecycle = createInterviewGuardWorker({ sweep: vi.fn().mockResolvedValue(undefined) });
    await expect(lifecycle.start()).rejects.toThrow('Redis unavailable');
    expect(mocks.worker).not.toHaveBeenCalled();
    await lifecycle.start(); await lifecycle.stop();
    expect(mocks.worker).toHaveBeenCalledOnce();
  });
});
