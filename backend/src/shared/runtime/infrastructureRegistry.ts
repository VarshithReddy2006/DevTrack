// src/shared/runtime/infrastructureRegistry.ts — Centralized infrastructure state tracking
// Singleton registry that tracks the health of all infrastructure subsystems.
// Read-only snapshots exposeable by health endpoints.

import mongoose from 'mongoose';
import { logger } from '../logger.js';
import type { RedisHealth } from '../redis/client.js';

// ---------------------------------------------------------------------------
// Subsystem health states
// ---------------------------------------------------------------------------

export type SubsystemStatus =
  | 'unknown'
  | 'initializing'
  | 'healthy'
  | 'degraded'
  | 'stopped'
  | 'failed';

export interface SubsystemState {
  status: SubsystemStatus;
  statusSince: number; // epoch ms
  error?: string;
  details?: Record<string, unknown>;
}

export interface InfrastructureState {
  api: SubsystemState;
  mongodb: SubsystemState;
  redis: SubsystemState;
  queues: SubsystemState;
  platformSyncWorker: SubsystemState;
  xpWorker: SubsystemState;
  scheduler: SubsystemState;
  sse: SubsystemState;
  degraded: boolean;
  degradedComponents: string[];
  startedAt: number;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Internal mutable store — lives outside any React/async context
// ---------------------------------------------------------------------------

interface RuntimeStore {
  api: SubsystemState;
  mongodb: SubsystemState;
  redis: SubsystemState;
  queues: SubsystemState;
  platformSyncWorker: SubsystemState;
  xpWorker: SubsystemState;
  scheduler: SubsystemState;
  sse: SubsystemState;
  startedAt: number;
}

const store: RuntimeStore = {
  api: { status: 'unknown', statusSince: Date.now() },
  mongodb: { status: 'unknown', statusSince: Date.now() },
  redis: { status: 'unknown', statusSince: Date.now() },
  queues: { status: 'unknown', statusSince: Date.now() },
  platformSyncWorker: { status: 'unknown', statusSince: Date.now() },
  xpWorker: { status: 'unknown', statusSince: Date.now() },
  scheduler: { status: 'unknown', statusSince: Date.now() },
  sse: { status: 'unknown', statusSince: Date.now() },
  startedAt: Date.now(),
};

// ---------------------------------------------------------------------------
// State update helpers
// ---------------------------------------------------------------------------

function updateSubsystem(
  key: keyof Omit<RuntimeStore, 'startedAt'>,
  status: SubsystemStatus,
  error?: string,
  details?: Record<string, unknown>
): void {
  const prev = store[key];
  const now = Date.now();

  if (prev.status !== status) {
    store[key] = { status, statusSince: now, error, details };
    emitLifecycleEvent(key, status, prev.status);
  } else if (error !== prev.error) {
    store[key] = { ...store[key], error, details };
  }
}

function emitLifecycleEvent(
  subsystem: string,
  newStatus: SubsystemStatus,
  prevStatus: SubsystemStatus
): void {
  const eventMap: Record<string, string> = {
    redis: newStatus === 'healthy' ? 'redis_connected' :
           newStatus === 'degraded' ? 'redis_degraded' :
           newStatus === 'failed' ? 'redis_disconnected' :
           prevStatus === 'healthy' ? 'redis_disconnected' : '',

    platformSyncWorker: newStatus === 'healthy' ? 'worker_started' :
                       newStatus === 'stopped' ? 'worker_stopped' : '',

    xpWorker: newStatus === 'healthy' ? 'xp_worker_started' :
              newStatus === 'stopped' ? 'xp_worker_stopped' : '',

    scheduler: newStatus === 'healthy' ? 'scheduler_resumed' :
               newStatus === 'stopped' ? 'scheduler_paused' : '',

    sse: newStatus === 'healthy' ? 'sse_connected' :
         newStatus === 'degraded' ? 'sse_degraded' : '',
  };

  const eventName = eventMap[subsystem];
  if (eventName) {
    logger.info(`[infrastructure] ${eventName}`, {
      event: eventName,
      subsystem,
      previousStatus: prevStatus,
      currentStatus: newStatus,
    });
  }

  // Emit degraded mode event when any critical subsystem fails
  if (newStatus === 'failed' || newStatus === 'degraded') {
    const degraded = isOverallDegraded();
    if (degraded) {
      logger.warn('[infrastructure] degraded_mode_entered', {
        event: 'degraded_mode_entered',
        subsystem,
        degradedComponents: getDegradedComponents(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Live state synchronization
// ---------------------------------------------------------------------------

function syncLiveDependencies(): void {
  try {
    const readyState = mongoose.connection?.readyState;
    if (readyState === 0 && store.mongodb.status === 'healthy') {
      store.mongodb = { status: 'failed', statusSince: Date.now(), error: 'MongoDB disconnected' };
    } else if (readyState === 1 && store.mongodb.status === 'unknown') {
      store.mongodb = { status: 'healthy', statusSince: Date.now() };
      if (store.api.status === 'unknown') {
        store.api = { status: 'healthy', statusSince: Date.now() };
      }
    } else if (readyState === 2 && store.mongodb.status === 'unknown') {
      store.mongodb = { status: 'initializing', statusSince: Date.now() };
    }
  } catch {
    // Ignore in unit test or decoupled environments
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function getInfrastructureState(): InfrastructureState {
  syncLiveDependencies();
  const degradedComponents = getDegradedComponents();
  const degraded = degradedComponents.length > 0;
  return {
    api: store.api,
    mongodb: store.mongodb,
    redis: store.redis,
    queues: store.queues,
    platformSyncWorker: store.platformSyncWorker,
    xpWorker: store.xpWorker,
    scheduler: store.scheduler,
    sse: store.sse,
    degraded,
    degradedComponents,
    startedAt: store.startedAt,
  };
}

export function isOverallDegraded(): boolean {
  return getDegradedComponents().length > 0;
}

export function getDegradedComponents(): string[] {
  syncLiveDependencies();
  const degraded: string[] = [];

  // Critical dependencies
  if (store.api.status !== 'healthy') {
    degraded.push('api');
  }
  if (store.mongodb.status !== 'healthy') {
    degraded.push('mongodb');
  }

  // Optional infrastructure dependencies
  if (store.redis.status === 'degraded' || store.redis.status === 'failed') {
    degraded.push('redis');
  }
  if (store.queues.status === 'degraded' || store.queues.status === 'failed') {
    degraded.push('queues');
  }

  // Workers: in split production, workers are stopped intentionally on the API server
  const workersDisabled = process.env.ENABLE_WORKERS === 'false';
  if (
    store.platformSyncWorker.status === 'degraded' ||
    store.platformSyncWorker.status === 'failed' ||
    (!workersDisabled && store.platformSyncWorker.status === 'stopped')
  ) {
    degraded.push('platformSyncWorker');
  }
  if (
    store.xpWorker.status === 'degraded' ||
    store.xpWorker.status === 'failed' ||
    (!workersDisabled && store.xpWorker.status === 'stopped')
  ) {
    degraded.push('xpWorker');
  }

  if (store.scheduler.status === 'degraded' || store.scheduler.status === 'failed') {
    degraded.push('scheduler');
  }
  if (store.sse.status === 'degraded' || store.sse.status === 'failed') {
    degraded.push('sse');
  }

  return degraded;
}

// ---------------------------------------------------------------------------
// Public update API
// ---------------------------------------------------------------------------

export function setApiStatus(status: SubsystemStatus, error?: string): void {
  updateSubsystem('api', status, error);
}

export function setMongoStatus(status: SubsystemStatus, error?: string): void {
  updateSubsystem('mongodb', status, error);
}

export function setRedisStatus(status: SubsystemStatus, error?: string, details?: Record<string, unknown>): void {
  const health: RedisHealth = {
    status: status === 'healthy' ? 'connected' : status === 'initializing' ? 'connecting' : 'disconnected',
    host: '', port: 0, lastError: error ?? null, reconnectAttempts: 0,
    ...details as Partial<RedisHealth>,
  };
  updateSubsystem('redis', status, error, { redisHealth: health });
}

export function setQueuesStatus(status: SubsystemStatus, error?: string): void {
  updateSubsystem('queues', status, error);
}

export function setPlatformSyncWorkerStatus(status: SubsystemStatus, error?: string): void {
  updateSubsystem('platformSyncWorker', status, error);
}

export function setXpWorkerStatus(status: SubsystemStatus, error?: string): void {
  updateSubsystem('xpWorker', status, error);
}

export function setSchedulerStatus(status: SubsystemStatus, error?: string): void {
  updateSubsystem('scheduler', status, error);
}

export function setSseStatus(status: SubsystemStatus, error?: string): void {
  updateSubsystem('sse', status, error);
}

export function resetInfrastructureStoreForTesting(): void {
  store.api = { status: 'unknown', statusSince: Date.now() };
  store.mongodb = { status: 'unknown', statusSince: Date.now() };
  store.redis = { status: 'unknown', statusSince: Date.now() };
  store.queues = { status: 'unknown', statusSince: Date.now() };
  store.platformSyncWorker = { status: 'unknown', statusSince: Date.now() };
  store.xpWorker = { status: 'unknown', statusSince: Date.now() };
  store.scheduler = { status: 'unknown', statusSince: Date.now() };
  store.sse = { status: 'unknown', statusSince: Date.now() };
  store.startedAt = Date.now();
}
