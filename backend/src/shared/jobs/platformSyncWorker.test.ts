import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startPlatformSyncWorker, stopPlatformSyncWorker } from './platformSyncWorker.js';

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), xp: vi.fn(), streak: vi.fn(), started: vi.fn(), completed: vi.fn(), failed: vi.fn(),
  processor: null as null | ((job: unknown) => Promise<unknown>),
}));
vi.mock('../../modules/platform-sync/sync.service.js', () => ({ syncPlatform: mocks.sync }));
vi.mock('../../infrastructure/queues/WorkerFactory.js', () => ({ WorkerFactory: {
  createWorker: (_queue: unknown, processor: (job: unknown) => Promise<unknown>) => {
    mocks.processor = processor; return { on: vi.fn(), close: vi.fn() };
  },
} }));
vi.mock('../redis/index.js', () => ({ getRedisClient: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../sse/index.js', () => ({ eventBus: {
  emitSyncStarted: mocks.started, emitSyncCompleted: mocks.completed, emitSyncFailed: mocks.failed,
} }));
vi.mock('../syncState.js', () => ({ syncState: { beginSync: vi.fn(), completeSync: vi.fn() } }));
vi.mock('./queueFactory.js', () => ({ getXpProcessingQueue: () => ({ add: mocks.xp }), getStreakRecalcQueue: () => ({ add: mocks.streak }) }));
vi.mock('./dlq.service.js', () => ({ dlqService: { quarantineJob: vi.fn() } }));
vi.mock('../tracing/tracing.js', () => ({
  injectTraceIntoJob: (data: unknown) => data,
  runJobInTrace: (_data: unknown, run: () => Promise<unknown>) => run(),
}));

beforeEach(() => { vi.clearAllMocks(); startPlatformSyncWorker(); });
afterEach(async () => { await stopPlatformSyncWorker(); });
const job = { id: 'synthetic', data: { userId: 'owner', platformName: 'leetcode' }, attemptsMade: 0 };

it.each([true, false])('does not duplicate coordinator notifications for success=%s', async success => {
  const result = { success, platform: 'leetcode', error: success ? undefined : 'provider unavailable' };
  mocks.sync.mockResolvedValueOnce(result);
  expect(await mocks.processor!(job)).toEqual(result);
  expect(mocks.started).not.toHaveBeenCalled();
  expect(mocks.completed).not.toHaveBeenCalled();
  expect(mocks.failed).not.toHaveBeenCalled();
  expect(mocks.xp).toHaveBeenCalledTimes(success ? 1 : 0);
  expect(mocks.streak).toHaveBeenCalledTimes(success ? 1 : 0);
});
it('still reports and propagates exceptional worker failures for queue retry handling', async () => {
  mocks.sync.mockRejectedValueOnce(new Error('unexpected failure'));
  await expect(mocks.processor!(job)).rejects.toThrow('unexpected failure');
  expect(mocks.failed).toHaveBeenCalledExactlyOnceWith('owner', 'leetcode', 'unexpected failure');
});
