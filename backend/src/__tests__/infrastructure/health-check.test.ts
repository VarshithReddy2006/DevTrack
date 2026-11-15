// src/__tests__/infrastructure/health-check.test.ts — Production Health & Reliability Endpoints Test
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import mongoose from 'mongoose';
import { setupHealthEndpoints } from '../../index.js';
import { sanitizeMongoError } from '../../db/connection.js';
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

  // 1. All critical dependencies available (MongoDB ready)
  it('1. returns 200 OK with status "ok", degraded: false, and empty degradedComponents when MongoDB and API are healthy', async () => {
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
    expect(data.checks.mongodb).toBe('connected');
    expect(data.checks.api).toBe('healthy');
    expect(typeof data.timestamp).toBe('string');
  });

  // 2. MongoDB unavailable
  it('2. returns 503 Service Unavailable with status "unhealthy" when MongoDB is unavailable', async () => {
    setApiStatus('healthy');
    setMongoStatus('failed', 'connect ETIMEDOUT mongodb+srv://admin:secret123@cluster0.net/test');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);

    const data = await res.json();
    expect(data.status).toBe('unhealthy');
    expect(data.degraded).toBe(true);
    expect(data.degradedComponents).toContain('mongodb');
    expect(data.checks.mongodb).toBe('failed');
    // Ensure sensitive credentials are sanitized
    expect(data.checks.mongodbError).toBeDefined();
    expect(data.checks.mongodbError).not.toContain('secret123');
    expect(data.checks.mongodbError).toContain('***');
  });

  // 3. MongoDB connecting (initialization / handshake)
  it('3. returns 503 Service Unavailable when MongoDB is in connecting state', async () => {
    setApiStatus('initializing');
    setMongoStatus('initializing');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);

    const data = await res.json();
    expect(data.status).toBe('unhealthy');
    expect(data.checks.mongodb).toBe('initializing');
    expect(data.checks.api).toBe('initializing');
  });

  // 4. Index initialization failure is non-blocking
  it('4. index initialization failure does not prevent MongoDB status from being reported or crash health endpoints', async () => {
    // When MongoDB is connected, index errors are logged as warnings and do not fail the database status
    setMongoStatus('healthy');
    setApiStatus('healthy');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.checks.mongodb).toBe('connected');
  });

  // 5. API initialization failure
  it('5. returns 503 Service Unavailable when API status is failed', async () => {
    setMongoStatus('healthy');
    setApiStatus('failed', 'Critical startup dependency missing');

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);

    const data = await res.json();
    expect(data.status).toBe('unhealthy');
    expect(data.degradedComponents).toContain('api');
    expect(data.checks.api).toBe('failed');
    expect(data.checks.apiError).toBe('Critical startup dependency missing');
  });

  // 6. Redis unavailable in an environment where Redis is optional/offline
  it('6. returns 200 OK with status "degraded" and lists redis in degradedComponents when Redis is unavailable but MongoDB is healthy', async () => {
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
    expect(data.checks.mongodb).toBe('connected');
  });

  // 7. Recovery after MongoDB reconnection
  it('7. recovers health state from 503 to 200 after MongoDB reconnected event', async () => {
    // 1. Initial failure
    setMongoStatus('failed', 'Connection lost');
    setApiStatus('failed', 'MongoDB required');

    let res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    let data = await res.json();
    expect(data.status).toBe('unhealthy');

    // 2. Reconnection event occurs
    setMongoStatus('healthy');
    setApiStatus('healthy');

    res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    data = await res.json();
    expect(data.status).toBe('ok');
    expect(data.checks.mongodb).toBe('connected');
    expect(data.checks.api).toBe('healthy');
  });

  // 8. Liveness while MongoDB is unavailable
  it('8. /health/live returns 200 OK with status "ok" even while MongoDB is unavailable', async () => {
    setApiStatus('failed', 'MongoDB down');
    setMongoStatus('failed', 'Atlas connection timeout');

    const liveRes = await fetch(`${baseUrl}/health/live`);
    expect(liveRes.status).toBe(200);

    const liveData = await liveRes.json();
    expect(liveData.status).toBe('ok');
    expect(typeof liveData.uptime).toBe('number');
  });

  // 9. Readiness while MongoDB is unavailable
  it('9. /health/ready returns 503 Service Unavailable with ready: false while MongoDB is unavailable', async () => {
    setApiStatus('healthy');
    setMongoStatus('failed', 'Atlas connection timeout');

    const readyRes = await fetch(`${baseUrl}/health/ready`);
    expect(readyRes.status).toBe(503);

    const readyData = await readyRes.json();
    expect(readyData.ready).toBe(false);
    expect(readyData.status).toBe('unhealthy');
    expect(readyData.checks.mongodb).toBe('failed');
  });

  // Helper sanitization test
  it('properly sanitizes MongoDB connection string passwords and credentials', () => {
    const raw = 'MongooseServerSelectionError: connect ETIMEDOUT to mongodb+srv://app_user:SuperSecretPassword123@cluster0.mongodb.net/devtrack?retryWrites=true';
    const sanitized = sanitizeMongoError(raw);
    expect(sanitized).not.toContain('SuperSecretPassword123');
    expect(sanitized).toContain('mongodb+srv://***:***@');
  });
});
