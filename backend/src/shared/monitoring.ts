// src/shared/monitoring.ts - Production Monitoring Service
// ============================================================================
// Simple wrapper for production observability. Can be easily extended to
// integrate with Sentry, BetterStack, or Datadog.
// ============================================================================

import { logger } from './logger.js';
import { env } from '../config/index.js';

interface ErrorContext {
  userId?: string;
  requestId?: string;
  path?: string;
  method?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Report an error to production monitoring systems.
 */
export function reportError(error: unknown, context: ErrorContext = {}): void {
  const errorObj = error instanceof Error ? error : new Error(String(error));

  // 1. Log locally with structured metadata
  logger.error('[MONITORING] Error reported', errorObj, { ...context });

  // 2. Production-only integrations
  if (env.IS_PROD) {
    // Integrate Sentry or BetterStack here
    // Sentry.captureException(errorObj, { extra: context });
  }
}

/**
 * Track a performance metric.
 */
export function trackMetric(name: string, value: number, tags: Record<string, string> = {}): void {
  if (env.IS_PROD) {
    logger.info(`[METRIC] ${name}: ${value}`, tags);
  }
}

// ---------------------------------------------------------------------------
// SSE Metrics (TASK 4)
// ---------------------------------------------------------------------------

interface SseMetrics {
  successfulConnections: number;
  failedConnections: number;
  reconnectionAttempts: number;
  averageSessionDuration: number;
}

const sseMetrics: SseMetrics = {
  successfulConnections: 0,
  failedConnections: 0,
  reconnectionAttempts: 0,
  averageSessionDuration: 0,
};

const sseSessionStartTimes = new Map<string, number>();

export function trackSseConnectionSuccess(userId: string): void {
  sseMetrics.successfulConnections++;
  sseSessionStartTimes.set(userId, Date.now());
  trackMetric('sse.connection.success', 1, { userId });
}

export function trackSseConnectionFailure(userId: string, reason: string): void {
  sseMetrics.failedConnections++;
  trackMetric('sse.connection.failure', 1, { userId, reason });
}

export function trackSseReconnection(userId: string): void {
  sseMetrics.reconnectionAttempts++;
  trackMetric('sse.reconnection', 1, { userId });
}

export function trackSseDisconnection(userId: string): void {
  const startTime = sseSessionStartTimes.get(userId);
  if (startTime) {
    const duration = Date.now() - startTime;
    sseSessionStartTimes.delete(userId);
    trackMetric('sse.session.duration', duration, { userId });
  }
}

export function getSseMetrics(): SseMetrics {
  return { ...sseMetrics };
}

// ---------------------------------------------------------------------------
// Sync Lock Metrics (TASK 4)
// ---------------------------------------------------------------------------

interface SyncLockMetrics {
  lockAcquisitions: number;
  lockFailures: number;
  lockReleases: number;
  staleLocksCleaned: number;
  averageLockWaitTime: number;
}

const syncLockMetrics: SyncLockMetrics = {
  lockAcquisitions: 0,
  lockFailures: 0,
  lockReleases: 0,
  staleLocksCleaned: 0,
  averageLockWaitTime: 0,
};

const lockWaitTimes: number[] = [];

export function trackSyncLockAcquisition(userId: string, platform: string, waitTime?: number): void {
  syncLockMetrics.lockAcquisitions++;
  if (waitTime !== undefined) {
    lockWaitTimes.push(waitTime);
    if (lockWaitTimes.length > 100) lockWaitTimes.shift();
    syncLockMetrics.averageLockWaitTime = lockWaitTimes.reduce((a, b) => a + b, 0) / lockWaitTimes.length;
  }
  trackMetric('sync.lock.acquired', 1, { userId, platform });
}

export function trackSyncLockFailure(userId: string, platform: string): void {
  syncLockMetrics.lockFailures++;
  trackMetric('sync.lock.failed', 1, { userId, platform });
}

export function trackSyncLockRelease(userId: string, platform: string): void {
  syncLockMetrics.lockReleases++;
  trackMetric('sync.lock.released', 1, { userId, platform });
}

export function trackStaleLocksCleaned(count: number): void {
  syncLockMetrics.staleLocksCleaned += count;
  trackMetric('sync.lock.stale_cleaned', count);
}

export function getSyncLockMetrics(): SyncLockMetrics {
  return { ...syncLockMetrics };
}

// ---------------------------------------------------------------------------
// Data Integrity Metrics (TASK 4)
// ---------------------------------------------------------------------------

interface DataIntegrityMetrics {
  duplicateXpAwards: number;
  syncRacesDetected: number;
  streakResetsDuringSync: number;
  cacheStalenessIncidents: number;
}

const dataIntegrityMetrics: DataIntegrityMetrics = {
  duplicateXpAwards: 0,
  syncRacesDetected: 0,
  streakResetsDuringSync: 0,
  cacheStalenessIncidents: 0,
};

export function trackDuplicateXpAward(userId: string, sourceId: string): void {
  dataIntegrityMetrics.duplicateXpAwards++;
  trackMetric('data_integrity.duplicate_xp', 1, { userId, sourceId });
  logger.warn('[DATA_INTEGRITY] Duplicate XP award detected', { userId, sourceId });
}

export function trackSyncRaceDetected(userId: string, platform: string): void {
  dataIntegrityMetrics.syncRacesDetected++;
  trackMetric('data_integrity.sync_race', 1, { userId, platform });
  logger.warn('[DATA_INTEGRITY] Sync race condition detected', { userId, platform });
}

export function trackStreakResetDuringSync(userId: string): void {
  dataIntegrityMetrics.streakResetsDuringSync++;
  trackMetric('data_integrity.streak_reset', 1, { userId });
  logger.warn('[DATA_INTEGRITY] Streak reset during sync', { userId });
}

export function trackCacheStaleness(cacheKey: string, age: number): void {
  dataIntegrityMetrics.cacheStalenessIncidents++;
  trackMetric('data_integrity.cache_stale', age, { cacheKey });
  logger.warn('[DATA_INTEGRITY] Cache staleness detected', { cacheKey, age });
}

export function getDataIntegrityMetrics(): DataIntegrityMetrics {
  return { ...dataIntegrityMetrics };
}
