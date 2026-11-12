import { beforeEach, afterEach, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({
  validate: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), redisClose: vi.fn(),
  start: vi.fn(), stop: vi.fn(), monitorStart: vi.fn(), monitorStop: vi.fn(), flush: vi.fn(),
}));
vi.mock('./modules/runtime-state/unifiedRuntimeState.service.js', () => ({ unifiedRuntimeStateService: { flushPendingEvents: state.flush } }));
vi.mock('./shared/startup-validation.js', () => ({ validateStartup: state.validate }));
vi.mock('./db/index.js', () => ({ connectDatabase: state.connect, disconnectDatabase: state.disconnect }));
vi.mock('./shared/redis/index.js', () => ({ disconnectRedis: state.redisClose }));
vi.mock('./shared/logger.js', () => ({ logger: {
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
} }));
vi.mock('./shared/jobs/platformSyncWorker.js', () => ({ startPlatformSyncWorker: state.start, stopPlatformSyncWorker: state.stop }));
vi.mock('./workers/WorkerHealthMonitor.js', () => ({ WorkerHealthMonitor: class {
  start = state.monitorStart;
  stop = state.monitorStop;
} }));

let handlers: Record<string, (...args: unknown[]) => unknown>;
beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(state)) mock.mockReset().mockResolvedValue(undefined);
  handlers = {};
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: unknown[]) => unknown) => {
    handlers[event] = listener;
    return process;
  }) as typeof process.on);
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('WORKER_TYPE', 'sync');
  vi.stubGlobal('process', process);
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'worker-entrypoint.js']);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function ready() {
  await import('./worker-entrypoint.js');
  await vi.waitFor(() => expect(console.info).toHaveBeenCalledWith('[worker-entrypoint] Worker process ready', expect.objectContaining({ workerType: 'sync', event: 'worker_process_ready' })));
}

it.each(['SIGINT', 'SIGTERM'])('drains once for repeated %s then disconnects and exits zero', async signal => {
  await ready();
  handlers[signal](); handlers[signal]();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.flush).toHaveBeenCalledOnce();
  expect(state.flush.mock.invocationCallOrder[0]).toBeGreaterThan(state.stop.mock.invocationCallOrder[0]);
  expect(state.disconnect.mock.invocationCallOrder[0]).toBeGreaterThan(state.flush.mock.invocationCallOrder[0]);
  expect(state.monitorStart).toHaveBeenCalledOnce();
  expect(state.monitorStop).toHaveBeenCalledOnce();
  expect(state.disconnect).toHaveBeenCalledOnce();
  expect(state.redisClose).toHaveBeenCalledOnce();
  expect(state.disconnect.mock.invocationCallOrder[0]).toBeGreaterThan(state.stop.mock.invocationCallOrder[0]);
});

it('cleans partial startup and exits one instead of reporting ready', async () => {
  state.start.mockRejectedValueOnce(new Error('consumer failed'));
  await import('./worker-entrypoint.js');
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.disconnect).toHaveBeenCalledOnce();
  expect(state.redisClose).toHaveBeenCalledOnce();
  expect(console.info).not.toHaveBeenCalledWith('[worker-entrypoint] Worker process ready', expect.anything());
});

it('reports shutdown failure but still disconnects services and exits one', async () => {
  state.stop.mockRejectedValueOnce(new Error('close failed'));
  await ready();
  handlers.SIGTERM();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(state.disconnect).toHaveBeenCalledOnce();
  expect(state.redisClose).toHaveBeenCalledOnce();
});

it('preserves a fatal exit code if an error arrives during a signal drain', async () => {
  let resolve!: () => void;
  state.stop.mockReturnValueOnce(new Promise<void>(done => { resolve = done; }));
  await ready();
  handlers.SIGTERM();
  await vi.waitFor(() => expect(state.stop).toHaveBeenCalledOnce());
  handlers.unhandledRejection(new Error('fatal while draining'));
  resolve();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(state.stop).toHaveBeenCalledOnce();
});

it('closes Redis even if the database disconnect fails', async () => {
  state.disconnect.mockRejectedValueOnce(new Error('database close failed'));
  await ready();
  handlers.SIGTERM();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(state.redisClose).toHaveBeenCalledOnce();
});

it('rejects an invalid environment selector before any service call', async () => {
  vi.stubEnv('WORKER_TYPE', 'orchestration');
  await import('./worker-entrypoint.js');
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(state.validate).not.toHaveBeenCalled();
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
});

it.each(['unhandledRejection', 'uncaughtException'])('drains consumers and exits one on %s', async event => {
  await ready();
  handlers[event](new Error('fatal'));
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(state.stop).toHaveBeenCalledOnce();
  expect(state.redisClose).toHaveBeenCalledOnce();
});

it('reports runtime buffer drain failure but still closes database and Redis', async () => {
  state.flush.mockRejectedValueOnce(new Error('buffer drain failed'));
  await ready(); handlers.SIGTERM();
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(state.disconnect).toHaveBeenCalledOnce(); expect(state.redisClose).toHaveBeenCalledOnce();
});