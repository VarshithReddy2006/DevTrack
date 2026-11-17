// src/shared/runtime/orchestrator.ts — Boot orchestrator (entry point for index.ts)
// Wires multi-phase startup + graceful shutdown into a single callable.

import type { Server } from 'node:http';
import type { Express } from 'express';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase, sanitizeMongoError, scheduleMongoReconnect } from '../../db/connection.js';
import { setupProductionIndexes } from '../../db/migrations/index-setup.js';
import { logger } from '../logger.js';
import { eventBus } from '../sse/index.js';
import { getRedisClient, disconnectRedis, getRedisHealth } from '../redis/index.js';
import { getOrCreateQueue, closeAllQueues, QueueNames } from '../jobs/index.js';
import { startAllWorkers, stopAllWorkers } from '../jobs/workers.js';
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

async function bootMongo(retries = 3, retryDelayMs = 2000): Promise<boolean> {
  setMongoStatus('initializing');
  for (let attempt = 1; attempt <= retries; attempt++) {
    assertStarting();
    try {
      logger.info(`[startup] MongoDB connection attempt ${attempt}/${retries}...`);
      await connectDatabase();

      logger.info('[startup] Verifying production database indexes...');
      try {
        await Promise.race([
          setupProductionIndexes(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Index setup timed out after 10s')), 10000)),
        ]);
        logger.info('[startup] Production indexes verified successfully');
      } catch (idxErr) {
        logger.warn('[startup] Production index setup encountered non-blocking warning', {
          error: idxErr instanceof Error ? idxErr.message : String(idxErr),
        });
      }

      setMongoStatus('healthy');
      logger.info('[startup] MongoDB connected and ready', { event: 'mongodb_connected', readyState: mongoose.connection.readyState });
      return true;
    } catch (err) {
      assertStarting();
      const msg = err instanceof Error ? err.message : String(err);
      const safeMsg = typeof sanitizeMongoError === 'function' ? sanitizeMongoError(msg) : msg;
      logger.error(`[startup] MongoDB connection attempt ${attempt}/${retries} failed: ${safeMsg}`);
      if (attempt < retries) {
        logger.info(`[startup] Waiting ${retryDelayMs}ms before retrying MongoDB connection...`);
        await new Promise((r) => setTimeout(r, retryDelayMs));
      } else {
        setMongoStatus('failed', safeMsg);
        if (typeof scheduleMongoReconnect === 'function') scheduleMongoReconnect();
      }
    }
  }
  return false;
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

// Recurring work (mission generation, platform sync sweeps, cleanups) is a set of BullMQ
// repeatables registered by the maintenance worker, so the API process runs no timers of its own.
// The scheduler subsystem is healthy when the queues that hold those schedules are available.
function bootScheduler(queuesOk: boolean): boolean {
  if (!queuesOk) {
    setSchedulerStatus('degraded', 'Queues unavailable');
    logger.warn('[startup] Scheduler paused — queues not available', { event: 'scheduler_paused', reason: 'queues_unavailable' });
    return false;
  }
  setSchedulerStatus('healthy');
  logger.info('[startup] Recurring jobs are BullMQ repeatables owned by the maintenance worker', { event: 'scheduler_resumed' });
  return true;
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

export function shutdown(server?: Server): Promise<void> {
  shutdownRequested = true;
  shutdownPromise ??= performShutdown(server);
  return shutdownPromise;
}

export function registerShutdownSignals(server: Server, afterShutdown?: () => Promise<void>): void {
  const handleSignal = () => {
    if (shutdownRequested) return;

    // The individual phase budgets total 14 seconds.
    const watchdog = setTimeout(() => {
      logger.error('[shutdown] Forced shutdown after timeout');
      process.exit(1);
    }, 15_000);

    void shutdown(server).then(() => afterShutdown?.()).then(
      () => {
        clearTimeout(watchdog);
        process.exit(0);
      },
      (error: unknown) => {
        clearTimeout(watchdog);
        logger.error('[shutdown] Shutdown failed', error);
        process.exit(1);
      },
    );
  };

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);
}

async function performShutdown(server?: Server): Promise<void> {
  const startedAt = Date.now();
  const failures: string[] = [];
  let firstError: unknown;
  logger.info('[shutdown] Initiating graceful shutdown');

  async function runPhase(name: string, timeoutMs: number, task: () => void | Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(task),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return true;
    } catch (error) {
      if (failures.length === 0) firstError = error;
      failures.push(name);
      logger.error(`[shutdown] ${name} failed`, error);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  setApiStatus('stopped');
  const trafficDrained = await runPhase('HTTP and SSE drain', 2_000, async () => {
    const httpClosed = server && new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    try {
      setSchedulerStatus('stopped');
      eventBus.broadcastShutdown();
    } finally {
      await httpClosed;
    }
    setSseStatus('stopped');
  });
  if (!trafficDrained) server?.closeAllConnections();

  // Worker.close() stops local consumption and drains active jobs. A global
  // Queue.pause() would also stop healthy workers in other replicas.
  if (await runPhase('BullMQ worker drain', 5_000, () => stopAllWorkers(5_000))) {
    setPlatformSyncWorkerStatus('stopped');
    setXpWorkerStatus('stopped');
  }
  if (await runPhase('BullMQ queue close', 1_000, closeAllQueues)) {
    setQueuesStatus('stopped');
  }

  await runPhase('Runtime state and audit flush', 3_000, async () => {
    const results = await Promise.allSettled([
      import('../../modules/runtime-state/unifiedRuntimeState.service.js')
        .then(({ unifiedRuntimeStateService }) => unifiedRuntimeStateService.flushPendingEvents()),
      import('../../modules/ai/audit/AIResponseAuditLog.js')
        .then(({ AIResponseAuditLog }) => AIResponseAuditLog.flushPendingWrites()),
    ]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Pending writes failed to flush');
  });

  await runPhase('Redis teardown', 1_000, async () => {
    try {
      eventBus.shutdown();
    } finally {
      await disconnectRedis();
    }
    setRedisStatus('stopped');
  });
  await runPhase('MongoDB teardown', 2_000, disconnectDatabase);

  setApiStatus('stopped');
  const metrics = { durationMs: Date.now() - startedAt, failedPhases: failures };
  if (failures.length) {
    logger.warn('[shutdown] Graceful shutdown finished with errors', metrics);
    throw firstError;
  }
  logger.info('[shutdown] Graceful shutdown complete', { event: 'shutdown_complete', ...metrics });
}

// ---------------------------------------------------------------------------
// Combined orchestrator object (index.ts surface)
// ---------------------------------------------------------------------------

export const orchestrator = { startup, shutdown };
