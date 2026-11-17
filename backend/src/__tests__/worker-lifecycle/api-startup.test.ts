import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  connect: vi.fn(), start: vi.fn(), stop: vi.fn(), queuesClose: vi.fn(), redisClose: vi.fn(), flush: vi.fn(),
  auditFlush: vi.fn(), sseDrain: vi.fn(), sseClose: vi.fn(), mongoClose: vi.fn(),
  setSync: vi.fn(), setXp: vi.fn(), ready: true,
}));
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../db/connection.js', () => ({ connectDatabase: state.connect, disconnectDatabase: state.mongoClose }));
vi.mock('../../modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { flushPendingEvents: state.flush } }));
vi.mock('../../modules/ai/audit/AIResponseAuditLog.js', () => ({ AIResponseAuditLog: { flushPendingWrites: state.auditFlush } }));
vi.mock('../../db/migrations/index-setup.js', () => ({ setupProductionIndexes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../shared/sse/index.js', () => ({ eventBus: { broadcastShutdown: state.sseDrain, shutdown: state.sseClose } }));
vi.mock('../../shared/redis/index.js', () => ({
  getRedisClient: () => ({ status: 'ready' }), disconnectRedis: state.redisClose,
  getRedisHealth: () => ({ status: state.ready ? 'connected' : 'disconnected' }),
}));
vi.mock('../../shared/jobs/index.js', () => ({
  getOrCreateQueue: vi.fn(), closeAllQueues: state.queuesClose,
  QueueNames: { PLATFORM_SYNC: 'platform-sync', XP_PROCESSING: 'xp-processing' },
}));
vi.mock('../../shared/jobs/workers.js', () => ({ startAllWorkers: state.start, stopAllWorkers: state.stop }));
vi.mock('../../shared/runtime/infrastructureRegistry.js', () => ({
  setApiStatus: vi.fn(), setMongoStatus: vi.fn(), setRedisStatus: vi.fn(), setQueuesStatus: vi.fn(),
  setPlatformSyncWorkerStatus: state.setSync, setXpWorkerStatus: state.setXp, setSchedulerStatus: vi.fn(), setSseStatus: vi.fn(),
}));
import express from 'express';
import { createServer } from 'node:http';
let startup: typeof import('../../shared/runtime/orchestrator.js')['startup'];
let registerShutdownSignals: typeof import('../../shared/runtime/orchestrator.js')['registerShutdownSignals'];
let shutdown: typeof import('../../shared/runtime/orchestrator.js')['shutdown'];
beforeEach(async () => {
  vi.resetModules();
  state.ready = true;
  for (const item of Object.values(state)) if (typeof item === 'function') item.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('ENABLE_WORKERS', 'true');
  ({ startup, shutdown, registerShutdownSignals } = await import('../../shared/runtime/orchestrator.js'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('starts the shared registry and drains it before closing queue and Redis handles', async () => {
  const result = await startup(express());
  expect(state.start).toHaveBeenCalledOnce();
  expect(result.phases.platformSyncWorker).toBe(true);
  await shutdown();
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.queuesClose.mock.invocationCallOrder[0]).toBeGreaterThan(state.stop.mock.invocationCallOrder[0]);
  expect(state.flush).toHaveBeenCalledOnce();
  expect(state.flush.mock.invocationCallOrder[0]).toBeGreaterThan(state.queuesClose.mock.invocationCallOrder[0]);
  expect(state.redisClose).toHaveBeenCalledAfter(state.flush);
  expect(state.redisClose).toHaveBeenCalledAfter(state.auditFlush);
});
it('reports the scheduler healthy from the queues alone, the API starts no cron timers', async () => {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  const result = await startup(express());
  expect(result.phases.scheduler).toBe(true);
  expect(intervals).not.toHaveBeenCalled();
});
it('keeps the scheduler degraded while the queues behind the schedules are unavailable', async () => {
  state.ready = false;
  expect((await startup(express())).phases.scheduler).toBe(false);
});
it.each(['disabled', 'offline'])('does not start consumers when %s', async reason => {
  if (reason === 'disabled') vi.stubEnv('ENABLE_WORKERS', 'false'); else state.ready = false;
  const result = await startup(express());
  expect(state.start).not.toHaveBeenCalled();
  expect(result.phases.platformSyncWorker).toBe(false);
  if (reason === 'disabled') expect(result.degraded).toBe(false);
});
it('reports worker startup failure instead of claiming healthy consumers', async () => {
  state.start.mockRejectedValueOnce(new Error('consumer initialization failed'));
  const result = await startup(express());
  expect(result.degraded).toBe(true);
  expect(result.phases.xpWorker).toBe(false);
  expect(state.setXp).toHaveBeenCalledWith('failed', 'consumer initialization failed');
});
it('closes infrastructure and propagates consumer drain failure', async () => {
  state.stop.mockRejectedValueOnce(new Error('deadline exceeded'));
  await expect(shutdown()).rejects.toThrow('deadline exceeded');
  expect(state.queuesClose).toHaveBeenCalledOnce(); expect(state.redisClose).toHaveBeenCalledOnce();
});
it('closes infrastructure and propagates runtime-state drain failure', async () => {
  state.flush.mockRejectedValueOnce(new Error('runtime write failed'));
  await expect(shutdown()).rejects.toThrow('runtime write failed');
  expect(state.queuesClose).toHaveBeenCalledOnce(); expect(state.redisClose).toHaveBeenCalledOnce();
});

it('prevents late startup from creating workers after shutdown and drains once', async () => {
  let resolve!: () => void;
  state.connect.mockReturnValueOnce(new Promise<void>(done => { resolve = done; }));
  const starting = startup(express());
  const interrupted = expect(starting).rejects.toThrow('interrupted by shutdown');
  await vi.waitFor(() => expect(state.connect).toHaveBeenCalledOnce());
  await Promise.all([shutdown(), shutdown()]);
  resolve(); await interrupted;
  expect(state.start).not.toHaveBeenCalled(); expect(state.stop).toHaveBeenCalledOnce();
  expect(state.redisClose).toHaveBeenCalledOnce();
  expect(state.flush).toHaveBeenCalledOnce();
});

it.each(['SIGTERM', 'SIGINT'] as const)('drains resources in order when it receives %s', async signal => {
  const server = createServer();
  const httpClose = vi.spyOn(server, 'close').mockImplementation(callback => {
    callback?.();
    return server;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  let finishMongoClose!: () => void;
  state.mongoClose.mockReturnValueOnce(new Promise<void>(resolve => { finishMongoClose = resolve; }));
  let finishTelemetry!: () => void;
  const telemetryDone = new Promise<void>(resolve => { finishTelemetry = resolve; });
  const flushTelemetry = vi.fn(() => telemetryDone);
  registerShutdownSignals(server, flushTelemetry);
  const sigtermHandler = process.listeners('SIGTERM').at(-1)!;
  const sigintHandler = process.listeners('SIGINT').at(-1)!;

  try {
    const handler = signal === 'SIGTERM' ? sigtermHandler : sigintHandler;
    handler(signal);
    handler(signal);
    const draining = shutdown();
    await vi.waitFor(() => expect(state.mongoClose).toHaveBeenCalledOnce());
    expect(flushTelemetry).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    finishMongoClose();
    await draining;
    await vi.waitFor(() => expect(flushTelemetry).toHaveBeenCalledOnce());
    expect(exit).not.toHaveBeenCalled();
    finishTelemetry();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));

    expect(httpClose).toHaveBeenCalledOnce();
    expect(state.stop).toHaveBeenCalledExactlyOnceWith(5000);
    const calls = [
      httpClose, state.sseDrain, state.stop, state.queuesClose, state.flush,
      state.sseClose, state.redisClose, state.mongoClose, flushTelemetry, exit,
    ].map(mock => mock.mock.invocationCallOrder[0]);
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
  } finally {
    process.off('SIGTERM', sigtermHandler);
    process.off('SIGINT', sigintHandler);
  }
});

it('keeps closing resources when individual phases time out or reject late', async () => {
  vi.useFakeTimers();
  let rejectWorkerDrain!: (error: Error) => void;
  state.stop.mockReturnValueOnce(new Promise((_, reject) => { rejectWorkerDrain = reject; }));
  state.flush.mockReturnValueOnce(new Promise(() => {}));
  state.redisClose.mockRejectedValueOnce(new Error('Redis failed'));

  const draining = expect(shutdown()).rejects.toThrow('BullMQ worker drain timed out');
  await vi.advanceTimersByTimeAsync(5000);
  expect(state.queuesClose).toHaveBeenCalledOnce();
  expect(state.redisClose).not.toHaveBeenCalled();
  rejectWorkerDrain(new Error('late worker failure'));
  await vi.advanceTimersByTimeAsync(3000);
  await draining;
  expect(state.mongoClose).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
