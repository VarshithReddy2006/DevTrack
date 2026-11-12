// src/shared/runtime/orchestrator.ts — Boot orchestrator (entry point for index.ts)
// Wires multi-phase startup + graceful shutdown into a single callable.

import type { Express } from 'express';
import mongoose from 'mongoose';
import { connectDatabase } from '../../db/connection.js';
import { setupProductionIndexes } from '../../db/migrations/index-setup.js';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { eventBus } from '../sse/index.js';
import { getRedisClient, disconnectRedis, getRedisHealth } from '../redis/index.js';
import { getOrCreateQueue, closeAllQueues, QueueNames } from '../jobs/index.js';
import { startAllWorkers, stopAllWorkers } from '../jobs/workers.js';
import {
  startSyncScheduler,
  stopSyncScheduler,
} from '../syncScheduler.js';
import {
  startMissionScheduler,
  stopMissionScheduler,
} from '../scheduler/missionScheduler.js';
import {
  setApiStatus,
  setMongoStatus,
  setRedisStatus,
  setQueuesStatus,
  setPlatformSyncWorkerStatus,
  setXpWorkerStatus,
  setSchedulerStatus,
  setSseStatus,
} from './infrastructureRegistry.js';

let shutdownRequested = false;
let shutdownPromise: Promise<void> | undefined;
function assertStarting(): void {
  if (shutdownRequested) throw new Error('Startup interrupted by shutdown');
}

export interface StartupResult {
  success: boolean;
  degraded: boolean;
  warnings: string[];
  phases: {
    mongodb: boolean;
    redis: boolean;
    queues: boolean;
    platformSyncWorker: boolean;
    xpWorker: boolean;
    scheduler: boolean;
    retention: boolean;
  };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function bootMongo(): Promise<boolean> {
  setMongoStatus('initializing');
  try {
    await connectDatabase();
    await setupProductionIndexes();
    setMongoStatus('healthy');
    logger.info('[startup] MongoDB connected', { event: 'mongodb_connected' });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setMongoStatus('failed', msg);
    logger.error('[startup] MongoDB connection failed', err as Error);
    return false;
  }
}

async function bootRedis(): Promise<boolean> {
  setRedisStatus('initializing');
  try {
    const client = getRedisClient();
    if (client.status !== 'ready') await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        client.off('ready', done); client.off('error', done);
        resolve();
      };
      const timer = setTimeout(done, 3000);
      client.once('ready', done); client.once('error', done);
    });
    const health = getRedisHealth();
    if (health.status === 'connected') {
      setRedisStatus('healthy');
      logger.info('[startup] Redis connected', { event: 'redis_connected' });
      return true;
    }
    setRedisStatus('degraded', 'Redis not ready');
    logger.warn('[startup] Redis unavailable — operating in degraded mode', { event: 'redis_degraded', status: health.status });
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setRedisStatus('degraded', err instanceof Error ? err.message : String(err));
    logger.warn('[startup] Redis bootstrap failed — continuing without queues', { event: 'redis_degraded', error: msg });
    return false;
  }
}

async function bootQueues(redisOk: boolean): Promise<boolean> {
  if (!redisOk) {
    setQueuesStatus('degraded', 'Redis unavailable');
    return false;
  }
  setQueuesStatus('initializing');
  try {
    for (const name of [QueueNames.PLATFORM_SYNC, QueueNames.XP_PROCESSING, QueueNames.STREAK_RECALC, QueueNames.SYSTEM_MAINTENANCE, QueueNames.NOTIFICATIONS]) {
      getOrCreateQueue(name);
    }
    setQueuesStatus('healthy');
    logger.info('[startup] Queues initialized', { event: 'queues_initialized' });
    return true;
  } catch (err) {
    setQueuesStatus('failed', err instanceof Error ? err.message : String(err));
    logger.error('[startup] Queue bootstrap failed', err as Error);
    return false;
  }
}

async function bootWorkers(redisOk: boolean): Promise<{ platformSync: boolean; xp: boolean }> {
  if (process.env.ENABLE_WORKERS === 'false' || !redisOk) {
    const disabled = process.env.ENABLE_WORKERS === 'false';
    setPlatformSyncWorkerStatus(disabled ? 'stopped' : 'degraded', disabled ? 'Workers run in standalone processes' : 'Redis unavailable');
    setXpWorkerStatus(disabled ? 'stopped' : 'degraded', disabled ? 'Workers run in standalone processes' : 'Redis unavailable');
    return { platformSync: false, xp: false };
  }
  try {
    await startAllWorkers();
    setPlatformSyncWorkerStatus('healthy');
    setXpWorkerStatus('healthy');
    return { platformSync: true, xp: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPlatformSyncWorkerStatus('failed', message);
    setXpWorkerStatus('failed', message);
    logger.error('[startup] Worker registry failed; partial consumers drained', error);
    return { platformSync: false, xp: false };
  }
}

function bootScheduler(queuesOk: boolean): boolean {
  if (!queuesOk) {
    setSchedulerStatus('degraded', 'Queues unavailable');
    logger.warn('[startup] Scheduler paused — queues not available', { event: 'scheduler_paused', reason: 'queues_unavailable' });
    return false;
  }
  try {
    startSyncScheduler();
    startMissionScheduler(); // Start mission scheduler
    setSchedulerStatus('healthy');
    logger.info('[startup] Scheduler started (sync + missions)', { event: 'scheduler_resumed' });
    return true;
  } catch (err) {
    setSchedulerStatus('failed', err instanceof Error ? err.message : String(err));
    logger.error('[startup] Scheduler failed to start', err as Error);
    return false;
  }
}

export async function startup(app: Express): Promise<StartupResult> {
  assertStarting();
  setApiStatus('initializing');
  const warnings: string[] = [];

  const mongoOk = await bootMongo();
  assertStarting();
  if (!mongoOk) {
    setApiStatus('failed', 'MongoDB required');
    return { success: false, phases: { mongodb: false, redis: false, queues: false, platformSyncWorker: false, xpWorker: false, scheduler: false, retention: false }, degraded: true, warnings: ['MongoDB required — cannot start'] };
  }

  const redisOk = await bootRedis();
  assertStarting();
  if (!redisOk) warnings.push('Redis unavailable — BullMQ workers disabled');

  const queuesOk = await bootQueues(redisOk);
  assertStarting();
  if (!queuesOk && redisOk) warnings.push('Queue initialization failed');

  const workers = await bootWorkers(redisOk);
  assertStarting();
  if (process.env.ENABLE_WORKERS !== 'false') {
    if (!workers.platformSync) warnings.push('Platform sync worker not started');
    if (!workers.xp) warnings.push('XP worker not started');
  }

  const schedulerOk = bootScheduler(queuesOk);
  if (!schedulerOk) warnings.push('Scheduler paused');



  setSseStatus('healthy');
  setApiStatus('healthy');

  if (warnings.length > 0) {
    logger.warn('[startup] Operating in degraded mode', { event: 'degraded_mode_entered', warnings });
  }

  return {
    success: true,
    phases: { mongodb: mongoOk, redis: redisOk, queues: queuesOk, platformSyncWorker: workers.platformSync, xpWorker: workers.xp, scheduler: schedulerOk, retention: false },
    degraded: warnings.length > 0,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

export function shutdown(): Promise<void> {
  shutdownRequested = true;
  shutdownPromise ??= performShutdown();
  return shutdownPromise;
}

async function performShutdown(): Promise<void> {
  logger.info('[shutdown] Initiating graceful shutdown');

  stopSyncScheduler();
  stopMissionScheduler(); // Stop mission scheduler
  setSchedulerStatus('stopped');

  let workerError: unknown;
  try { await stopAllWorkers(); } catch (error) { workerError = error; }
  setPlatformSyncWorkerStatus('stopped');
  setXpWorkerStatus('stopped');

  await closeAllQueues();
  setQueuesStatus('stopped');

  try {
    const { unifiedRuntimeStateService } = await import('../../modules/runtime-state/unifiedRuntimeState.service.js');
    await unifiedRuntimeStateService.flushPendingEvents();
  } catch (error) { workerError ??= error; }
  await disconnectRedis();
  setRedisStatus('stopped');

  eventBus.shutdown?.();
  setSseStatus('stopped');

  setApiStatus('stopped');
  if (workerError) throw workerError;
  logger.info('[shutdown] Graceful shutdown complete', { event: 'shutdown_complete' });
}

// ---------------------------------------------------------------------------
// Combined orchestrator object (index.ts surface)
// ---------------------------------------------------------------------------

export const orchestrator = { startup, shutdown };
