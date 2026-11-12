// Standalone workers: reject invalid selectors before importing service modules.
import { createWorkerRuntime } from './workers/worker-runtime.js';

let disconnectDatabase: (() => Promise<void>) | undefined;
let disconnectRedis: (() => Promise<void>) | undefined;
let stopHealthMonitor: (() => void) | undefined;
let runtime: ReturnType<typeof createWorkerRuntime> | undefined;
let shutdownPromise: Promise<void> | undefined;
let exitCode = 0;
// Bootstrap errors must remain readable even when environment validation cannot load the logger.
let log: Pick<typeof import('./shared/logger.js')['logger'], 'info' | 'error'> = console;

function shutdown(signal: string, code = 0): Promise<void> {
  exitCode = Math.max(exitCode, code);
  shutdownPromise ??= (async () => {
    log.info(`[worker-entrypoint] ${signal}; draining workers`, { event: 'worker_process_shutdown', signal });
    try { await runtime?.stop(); } catch (error) {
      log.error('[worker-entrypoint] Cleanup failed', error);
      exitCode = 1;
    }
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  log.error('[worker-entrypoint] Unhandled rejection', error);
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  log.error('[worker-entrypoint] Uncaught exception', error);
  void shutdown('uncaughtException', 1);
});

async function main(): Promise<void> {
  runtime = createWorkerRuntime(process.argv[2] ?? (process.env.WORKER_TYPE || 'all'), {
    validate: async () => {
      const redis = await import('./shared/redis/index.js');
      disconnectRedis = redis.disconnectRedis;
      log = (await import('./shared/logger.js')).logger;
      log.info('[worker-entrypoint] Starting worker process', {
        event: 'worker_process_starting', workerType: runtime!.type, pid: process.pid,
      });
      const { validateStartup } = await import('./shared/startup-validation.js');
      await validateStartup();
    },
    connect: async () => {
      const database = await import('./db/index.js');
      disconnectDatabase = database.disconnectDatabase;
      await database.connectDatabase();
      const { WorkerHealthMonitor } = await import('./workers/WorkerHealthMonitor.js');
      const monitor = new WorkerHealthMonitor(runtime!.type);
      stopHealthMonitor = () => monitor.stop();
      monitor.start();
    },
    disconnect: async () => {
      const { unifiedRuntimeStateService } = await import('./modules/runtime-state/unifiedRuntimeState.service.js');
      try { await unifiedRuntimeStateService.flushPendingEvents(); } finally {
        try { stopHealthMonitor?.(); } finally {
          try { await disconnectDatabase?.(); } finally { await disconnectRedis?.(); }
        }
      }
    },
  });
  await runtime.start();
  if (!shutdownPromise) log.info('[worker-entrypoint] Worker process ready', {
    event: 'worker_process_ready', workerType: runtime.type, pid: process.pid,
  });
}

void main().catch(async (error) => {
  if (shutdownPromise) return;
  log.error('[worker-entrypoint] Fatal startup error', error);
  await shutdown('startup failure', 1);
});
