// src/workers/worker-sync.ts — Platform Sync Worker Process
// Standalone worker for platform synchronization (GitHub, LeetCode, etc.)
// Runs independently to isolate sync operations from other workers

import { connectDatabase, disconnectDatabase } from '../db/index.js';
import { logger } from '../shared/logger.js';
import { startPlatformSyncWorker, stopPlatformSyncWorker } from '../shared/jobs/platformSyncWorker.js';
import { WorkerHealthMonitor } from './WorkerHealthMonitor.js';
import { tokenPoolManager } from '../modules/sync/tokenPoolManager.service.js';

async function main(): Promise<void> {
  logger.info('[worker-sync] Starting platform sync worker', {
    event: 'worker_process_starting',
    workerType: 'sync',
    pid: process.pid,
  });

  await connectDatabase();
  
  // Initialize multi-token pool manager
  tokenPoolManager.init();
  
  // Start health monitoring
  const healthMonitor = new WorkerHealthMonitor('sync');
  healthMonitor.start();
  
  startPlatformSyncWorker();

  logger.info('[worker-sync] Platform sync worker ready', {
    event: 'worker_process_ready',
    workerType: 'sync',
    pid: process.pid,
  });

  // Store health monitor for shutdown
  (global as any).healthMonitor = healthMonitor;
}

async function shutdown(signal: string): Promise<void> {
  logger.info(`[worker-sync] Received ${signal}, shutting down gracefully`, {
    event: 'worker_process_shutdown',
    signal,
  });

  try {
    await stopPlatformSyncWorker();
    await tokenPoolManager.close();
    
    const healthMonitor = (global as any).healthMonitor;
    if (healthMonitor) {
      healthMonitor.stop();
    }
    
    await disconnectDatabase();
  } catch (err) {
    logger.error('[worker-sync] Error during shutdown', err);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error('[worker-sync] Unhandled rejection', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('[worker-sync] Uncaught exception — exiting', err);
  process.exit(1);
});

main().catch((err) => {
  logger.error('[worker-sync] Fatal startup error', err);
  process.exit(1);
});
