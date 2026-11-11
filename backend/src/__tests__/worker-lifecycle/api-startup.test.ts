import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  connect: vi.fn(), start: vi.fn(), stop: vi.fn(), queuesClose: vi.fn(), redisClose: vi.fn(),
  setSync: vi.fn(), setXp: vi.fn(), ready: true,
}));
vi.mock('../../config/env.js', () => ({ env: {} }));
vi.mock('../../db/connection.js', () => ({ connectDatabase: state.connect }));
vi.mock('../../db/migrations/index-setup.js', () => ({ setupProductionIndexes: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../shared/sse/index.js', () => ({ eventBus: { shutdown: vi.fn() } }));
vi.mock('../../shared/redis/index.js', () => ({
  getRedisClient: () => ({ status: 'ready' }), disconnectRedis: state.redisClose,
  getRedisHealth: () => ({ status: state.ready ? 'connected' : 'disconnected' }),
}));
vi.mock('../../shared/jobs/index.js', () => ({
  getOrCreateQueue: vi.fn(), closeAllQueues: state.queuesClose,
  QueueNames: { PLATFORM_SYNC: 'platform-sync', XP_PROCESSING: 'xp-processing' },
}));
vi.mock('../../shared/jobs/workers.js', () => ({ startAllWorkers: state.start, stopAllWorkers: state.stop }));
vi.mock('../../shared/syncScheduler.js', () => ({ startSyncScheduler: vi.fn(), stopSyncScheduler: vi.fn() }));
vi.mock('../../shared/scheduler/missionScheduler.js', () => ({ startMissionScheduler: vi.fn(), stopMissionScheduler: vi.fn() }));
vi.mock('../../shared/runtime/infrastructureRegistry.js', () => ({
  setApiStatus: vi.fn(), setMongoStatus: vi.fn(), setRedisStatus: vi.fn(), setQueuesStatus: vi.fn(),
  setPlatformSyncWorkerStatus: state.setSync, setXpWorkerStatus: state.setXp, setSchedulerStatus: vi.fn(), setSseStatus: vi.fn(),
}));
import express from 'express';
let startup: typeof import('../../shared/runtime/orchestrator.js')['startup'];
let shutdown: typeof import('../../shared/runtime/orchestrator.js')['shutdown'];
beforeEach(async () => {
  vi.resetModules();
  state.ready = true;
  for (const item of Object.values(state)) if (typeof item === 'function') item.mockReset().mockResolvedValue(undefined);
  vi.stubEnv('ENABLE_WORKERS', 'true');
  ({ startup, shutdown } = await import('../../shared/runtime/orchestrator.js'));
});
afterEach(() => vi.unstubAllEnvs());
it('starts the shared registry and drains it before closing queue and Redis handles', async () => {
  const result = await startup(express());
  expect(state.start).toHaveBeenCalledOnce();
  expect(result.phases.platformSyncWorker).toBe(true);
  await shutdown();
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.queuesClose.mock.invocationCallOrder[0]).toBeGreaterThan(state.stop.mock.invocationCallOrder[0]);
  expect(state.redisClose.mock.invocationCallOrder[0]).toBeGreaterThan(state.queuesClose.mock.invocationCallOrder[0]);
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
});
