// src/__tests__/infrastructure/health-check.test.ts — Production Health & Reliability Endpoints Test
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import mongoose from 'mongoose';
import { setupHealthEndpoints } from '../../index.js';
import {
  setApiStatus,
  setMongoStatus,
  setRedisStatus,
  setQueuesStatus,
  setPlatformSyncWorkerStatus,
  setXpWorkerStatus,
  setSchedulerStatus,
  setSseStatus,
  getInfrastructureState,
  getDegradedComponents,
  isOverallDegraded,
  resetInfrastructureStoreForTesting,
} from '../../shared/runtime/index.js';

describe('Health Check Infrastructure & Endpoints', () => {
  let app: express.Express;
  let server: Server;
  let baseUrl: string;

  const mockRedisHealth = vi.fn().mockReturnValue({
    status: 'connected', host: '127.0.0.1', port: 6379, lastError: null, reconnectAttempts: 0,
  });
  const mockWorkerStatus = vi.fn().mockReturnValue({ running: true });
  const mockXpWorkerStatus = vi.fn().mockReturnValue({ running: true });
  const mockGetOrCreateQueue = vi.fn().mockReturnValue({
    getJobCounts: async () => ({ active: 0, waiting: 0, failed: 0, completed: 0, delayed: 0 }),
  });
  const mockQueueNames = {
    PLATFORM_SYNC: 'platform-sync', SYSTEM_MAINTENANCE: 'system-maintenance',
    XP_PROCESSING: 'xp-processing', STREAK_RECALC: 'streak-recalc', NOTIFICATIONS: 'notifications',
  };
  const mockEventBus = {
    getMetrics: () => ({
      activeConnections: 1, totalConnections: 1, totalDisconnects: 0,
      totalReconnects: 0, heartbeatFailures: 0, eventsPublished: 5, uptimeSeconds: 60,
    }),
  };
  const mockSyncState = {
    getSnapshot: () => ({
      status: 'idle', lastSyncStartedAt: null, lastSyncCompletedAt: null,
      lastSyncStatus: null, lastSyncDurationMs: null, totalSyncs: 0, failedSyncs: 0,
    }),
  };

  beforeEach(async () => {
    resetInfrastructureStoreForTesting();
    app = express();
    setupHealthEndpoints(
      app,
      mockRedisHealth,
      mockWorkerStatus,
      mockXpWorkerStatus,
      mockGetOrCreateQueue,
      mockQueueNames,
      mockEventBus,
      mockSyncState,
      getInfrastructureState,
    );

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  // 1. All critical dependencies available
  it('1. returns 200 OK with status "ok", degraded: false, and empty degradedComponents when all dependencies are healthy', async () => {
    setApiStatus('healthy');
    setMongoStatus('healthy');
    setRedisStatus('healthy');
    setQueuesStatus('healthy');
    setPlatformSyncWorkerStatus('healthy');
    setXpWorkerStatus('healthy');
    setSchedulerStatus('healthy');
    setSseStatus('healthy');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.degraded).toBe(false);
    expect(data.degradedComponents).toEqual([]);
    expect(typeof data.timestamp).toBe('string');
  });

  // 2. MongoDB unavailable
  it('2. returns 503 Service Unavailable when MongoDB is disconnected or failed', async () => {
    setApiStatus('healthy');
    setMongoStatus('failed', 'Connection timed out');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);

    const data = await res.json();
    expect(data.status).toBe('degraded');
    expect(data.degraded).toBe(true);
    expect(data.degradedComponents).toContain('mongodb');
  });

  // 3. Redis unavailable in an environment where Redis is optional/offline
  it('3. returns 200 OK with status "degraded" and degradedComponents listing ["redis"] when Redis is down but core API is healthy', async () => {
    setApiStatus('healthy');
    setMongoStatus('healthy');
    setRedisStatus('degraded', 'Redis offline');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('degraded');
    expect(data.degraded).toBe(true);
    expect(data.degradedComponents).toContain('redis');
    expect(data.degradedComponents).not.toContain('mongodb');
  });

  // 4. Optional dependency unavailable (queues / workers)
  it('4. returns 200 OK with degraded status when optional queues or workers fail, and does not flag stopped workers when ENABLE_WORKERS=false', async () => {
    vi.stubEnv('ENABLE_WORKERS', 'false');
    setApiStatus('healthy');
    setMongoStatus('healthy');
    setRedisStatus('healthy');
    setQueuesStatus('degraded', 'Queues paused');
    setPlatformSyncWorkerStatus('stopped'); // Intentionally stopped on standalone API instance

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.status).toBe('degraded');
    expect(data.degraded).toBe(true);
    expect(data.degradedComponents).toContain('queues');
    // Because ENABLE_WORKERS is false, platformSyncWorker being stopped is expected and not degraded
    expect(data.degradedComponents).not.toContain('platformSyncWorker');
  });

  // 5. Initialization still in progress
  it('5. returns 503 Service Unavailable when initialization is still in progress', async () => {
    setApiStatus('initializing');
    setMongoStatus('initializing');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);

    const data = await res.json();
    expect(data.status).toBe('degraded');
    expect(data.degraded).toBe(true);
    expect(data.degradedComponents).toContain('api');
    expect(data.degradedComponents).toContain('mongodb');
  });

  // 6. Unexpected health-check exception
  it('6. handles unexpected state exceptions gracefully by returning 503 without leaking secrets', async () => {
    const errorApp = express();
    setupHealthEndpoints(
      errorApp,
      mockRedisHealth,
      mockWorkerStatus,
      mockXpWorkerStatus,
      mockGetOrCreateQueue,
      mockQueueNames,
      mockEventBus,
      mockSyncState,
      () => { throw new Error('Secret database password exposed: 12345'); },
    );

    const errorServer = errorApp.listen(0);
    const errorPort = (errorServer.address() as AddressInfo).port;

    try {
      const res = await fetch(`http://127.0.0.1:${errorPort}/health`);
      expect(res.status).toBe(503);

      const data = await res.json();
      expect(data.status).toBe('degraded');
      expect(data.degraded).toBe(true);
      expect(data.degradedComponents).toEqual(['api']);
      // Ensure error details don't leak passwords in response
      expect(JSON.stringify(data)).not.toContain('12345');
    } finally {
      errorServer.close();
    }
  });

  // 7. Empty degradedComponents with a healthy state
  it('7. guarantees degraded is never true when degradedComponents is empty', () => {
    setApiStatus('healthy');
    setMongoStatus('healthy');

    const state = getInfrastructureState();
    expect(state.degraded).toBe(false);
    expect(state.degradedComponents).toEqual([]);
    expect(isOverallDegraded()).toBe(false);

    // Now degrade one component
    setRedisStatus('degraded');
    const degradedState = getInfrastructureState();
    expect(degradedState.degraded).toBe(true);
    expect(degradedState.degradedComponents.length).toBeGreaterThan(0);
    expect(degradedState.degradedComponents).toContain('redis');
  });

  // 8. Correct HTTP status codes
  it('8. enforces correct HTTP status codes: 200 for healthy or optional degradation, 503 for critical infrastructure loss', async () => {
    // Healthy -> 200
    setApiStatus('healthy');
    setMongoStatus('healthy');
    const healthyRes = await fetch(`${baseUrl}/health`);
    expect(healthyRes.status).toBe(200);

    // Optional degradation (Redis down) -> 200
    setRedisStatus('degraded');
    const optionalRes = await fetch(`${baseUrl}/health`);
    expect(optionalRes.status).toBe(200);

    // Critical failure (Mongo down) -> 503
    setMongoStatus('failed', 'MongoDB connection lost');
    const criticalRes = await fetch(`${baseUrl}/health`);
    expect(criticalRes.status).toBe(503);

    // Critical failure (API down) -> 503
    setMongoStatus('healthy');
    setApiStatus('failed', 'Server shutting down');
    const apiRes = await fetch(`${baseUrl}/health`);
    expect(apiRes.status).toBe(503);
  });

  // 9. Liveness versus readiness behavior
  it('9. verifies distinct behavior between /health/live and /health/ready', async () => {
    // Process is alive even if MongoDB is not ready
    setApiStatus('initializing');
    setMongoStatus('initializing');

    const liveRes = await fetch(`${baseUrl}/health/live`);
    expect(liveRes.status).toBe(200);
    const liveData = await liveRes.json();
    expect(liveData.status).toBe('ok');
    expect(typeof liveData.uptime).toBe('number');

    const readyRes = await fetch(`${baseUrl}/health/ready`);
    expect(readyRes.status).toBe(503);
    const readyData = await readyRes.json();
    expect(readyData.ready).toBe(false);
    expect(readyData.status).toBe('unhealthy');

    // When MongoDB connects and API is healthy
    setApiStatus('healthy');
    setMongoStatus('healthy');

    const readyOkRes = await fetch(`${baseUrl}/health/ready`);
    expect(readyOkRes.status).toBe(200);
    const readyOkData = await readyOkRes.json();
    expect(readyOkData.ready).toBe(true);
    expect(readyOkData.status).toBe('ok');
    expect(readyOkData.checks.mongodb).toBe('connected');
    expect(readyOkData.checks.api).toBe('healthy');
  });
});
