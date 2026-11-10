// src/index.ts - DevTrack Backend Entry Point
import { createRequire } from 'node:module';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { env, API_BASE_PATH } from './config/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestContextMiddleware } from './middleware/requestContext.js';
import { authMiddleware, adminMiddleware, type AuthenticatedRequest } from './middleware/auth.js';
import { requestMetricsMiddleware, getMetricsSnapshot, getEndpointLatencies } from './shared/requestMetrics.js';
import { sanitizeRequest } from './middleware/validation.js';
import { logger } from './shared/logger.js';
import { eventBus } from './shared/sse/index.js';
import { syncState } from './shared/syncState.js';
import { getRedisHealth } from './shared/redis/index.js';
import { validateStartup } from './shared/startup-validation.js';
import { getOrCreateQueue, QueueNames } from './shared/jobs/index.js';
import { getWorkerStatus, getXpWorkerStatus } from './shared/jobs/index.js';
import { orchestrator } from './shared/runtime/index.js';
import { getInfrastructureState } from './shared/runtime/infrastructureRegistry.js';
import routes from './routes/index.js';
import { getRegisteredWorkerStatuses } from './shared/jobs/workers.js';
import { mountApiRoutes } from './routes/mount.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../package.json') as { version: string };

export async function createApp(): Promise<express.Express> {
  const app = express();

  // Root info endpoint
  app.get('/', (_req, res) => {
    res.json({
      message: 'DevTrack API Server is running',
      version: APP_VERSION,
      health: '/health',
      timestamp: new Date().toISOString()
    });
  });

  // Phase 1: Core middleware (before any async work)
  app.use(requestContextMiddleware);
  app.use(requestMetricsMiddleware);

  app.use(helmet({
    contentSecurityPolicy: env.IS_PROD ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    } : undefined,
    hsts: env.IS_PROD ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    } : undefined,
  }));

  app.use(cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Length', 'X-Request-ID', 'Retry-After'],
  }));

  app.use(morgan(env.IS_DEV ? 'dev' : 'combined'));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(sanitizeRequest);

  // Phase 2: Health & observability endpoints (before routes)
  setupHealthEndpoints(app, getRedisHealth, getWorkerStatus, getXpWorkerStatus, getOrCreateQueue, QueueNames, eventBus, syncState, getInfrastructureState);

  // Phase 3: API routes
  mountApiRoutes(app, routes);

  // Phase 4: Error handlers
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Phase 5: Orchestrated infrastructure boot (moved to bootstrap() to run non-blocking)
  // await orchestrator.startup(app);

  return app;
}

async function bootstrap() {
  // Phase 0: Validate critical dependencies and services
  // TEMPORARY: Skip validation to get server running without Redis
  // await validateStartup();

  if (env.IS_PROD) {
    if (!process.env.OPENAI_API_KEY && !env.GEMINI_API_KEY) {
      logger.error('CRITICAL: At least one AI API key (OPENAI_API_KEY or GEMINI_API_KEY) must be set in production');
      logger.error('Intelligence features will be degraded without AI API keys');
      process.exit(1);
    }
  } else {
    // Development mode: warn but allow startup
    if (!process.env.OPENAI_API_KEY && !env.GEMINI_API_KEY) {
      logger.warn('WARNING: No AI API keys set. Intelligence features will use mock/fallback responses.');
      logger.warn('Set OPENAI_API_KEY or GEMINI_API_KEY for full intelligence capabilities.');
    }
  }

  const app = await createApp();

  // Phase 6: HTTP server start (start BEFORE orchestrator to ensure server is listening even if Redis fails)
  const server = app.listen(env.PORT, () => {
    logger.info(`DevTrack backend listening on port ${env.PORT}`);
    logger.info(`Environment: ${env.NODE_ENV}`);
    logger.info(`API base path: ${API_BASE_PATH}`);
    logger.info(`AI Provider: ${process.env.OPENAI_API_KEY ? 'OpenAI configured' : env.GEMINI_API_KEY ? 'Gemini configured' : 'None (degraded mode)'}`);
  });

  // Phase 6.5: Start orchestrator in background (non-blocking)
  orchestrator.startup(app).catch((err) => {
    logger.error('Orchestrator startup failed (server still running in degraded mode)', err);
  });

  // Phase 7: Graceful shutdown — drain infrastructure before exiting
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down... stopping infrastructure');

    // Stop consumers immediately rather than waiting for lingering HTTP clients.
    const timeout = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
        orchestrator.shutdown(),
      ]);
      clearTimeout(timeout);
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      clearTimeout(timeout);
      logger.error('Shutdown failed', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// ---------------------------------------------------------------------------
// Health & system endpoints
// ---------------------------------------------------------------------------

function setupHealthEndpoints(
  app: express.Express,
  getRedisHealth: () => { status: string; host: string; port: number; lastError: string | null; reconnectAttempts: number },
  getWorkerStatus: () => { running: boolean },
  getXpWorkerStatus: () => { running: boolean },
  getOrCreateQueue: (name: string) => { getJobCounts(): Promise<{ active?: number; waiting?: number; failed?: number; completed?: number; delayed?: number }> },
  QueueNames: { PLATFORM_SYNC: string; SYSTEM_MAINTENANCE: string; XP_PROCESSING: string; STREAK_RECALC: string; NOTIFICATIONS: string },
  eventBus: { getMetrics(): { activeConnections: number; totalConnections: number; totalDisconnects: number; totalReconnects: number; heartbeatFailures: number; eventsPublished: number; uptimeSeconds: number } },
  syncState: { getSnapshot(): { status: string; lastSyncStartedAt: string | null; lastSyncCompletedAt: string | null; lastSyncStatus: 'success' | 'partial' | 'failed' | null; lastSyncDurationMs: number | null; totalSyncs: number; failedSyncs: number } },
  getInfrastructureState: () => { api: { status: string }; mongodb: { status: string }; redis: { status: string }; queues: { status: string }; platformSyncWorker: { status: string }; xpWorker: { status: string }; scheduler: { status: string }; sse: { status: string }; degraded: boolean; degradedComponents: string[]; startedAt: number },
): void {
  app.get('/health', (_req, res) => {
    const state = getInfrastructureState();
    res.json({
      status: state.api.status === 'healthy' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
      degraded: state.degraded,
      degradedComponents: state.degradedComponents,
    });
  });

  app.get('/health/detailed', authMiddleware, adminMiddleware, (req: AuthenticatedRequest, res: express.Response) => {
    const state = getInfrastructureState();
    const sseMetrics = eventBus.getMetrics();
    const syncSnapshot = syncState.getSnapshot();

    const memoryUsage = process.memoryUsage();
    const memoryMB = {
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      rss: Math.round(memoryUsage.rss / 1024 / 1024),
      external: Math.round(memoryUsage.external / 1024 / 1024),
    };

    const mongoState = mongoose.connection.readyState;
    const mongoLabels: Record<number, string> = {
      0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting',
    };

    const redisHealth = getRedisHealth();
    const workerStatus = getWorkerStatus();
    const xpWorkerStatus = getXpWorkerStatus();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
      requestId: req.context?.requestId,
      uptime: Math.floor(process.uptime()),
      memory: memoryMB,
      infrastructure: state,
      mongodb: {
        state: mongoLabels[mongoState] ?? 'unknown',
        readyState: mongoState,
      },
      redis: redisHealth,
      worker: workerStatus,
      xpWorker: xpWorkerStatus,
      sse: {
        activeConnections: sseMetrics.activeConnections,
        totalConnections: sseMetrics.totalConnections,
        totalDisconnects: sseMetrics.totalDisconnects,
        totalReconnects: sseMetrics.totalReconnects,
        heartbeatFailures: sseMetrics.heartbeatFailures,
        eventsPublished: sseMetrics.eventsPublished,
        uptimeSeconds: sseMetrics.uptimeSeconds,
      },
      scheduler: {
        running: syncSnapshot.status !== 'idle',
        status: syncSnapshot.status,
        totalSyncs: syncSnapshot.totalSyncs,
        failedSyncs: syncSnapshot.failedSyncs,
        lastSyncCompletedAt: syncSnapshot.lastSyncCompletedAt,
        lastSyncDurationMs: syncSnapshot.lastSyncDurationMs,
      },
    });
  });

  app.get('/metrics', authMiddleware, adminMiddleware, (_req: AuthenticatedRequest, res: express.Response) => {
    const snapshot = getMetricsSnapshot();
    const endpoints = getEndpointLatencies();

    // Prometheus-style text format for scrape-compatible tooling
    const lines: string[] = [
      `# HELP devtrack_uptime_seconds Server uptime in seconds`,
      `# TYPE devtrack_uptime_seconds gauge`,
      `devtrack_uptime_seconds ${snapshot.uptime}`,
      ``,
      `# HELP devtrack_total_requests Total HTTP requests processed`,
      `# TYPE devtrack_total_requests counter`,
      `devtrack_total_requests ${snapshot.totalRequests}`,
      ``,
      `# HELP devtrack_total_errors Total HTTP errors (4xx/5xx)`,
      `# TYPE devtrack_total_errors counter`,
      `devtrack_total_errors ${snapshot.totalErrors}`,
      ``,
      `# HELP devtrack_error_rate Error rate percentage`,
      `# TYPE devtrack_error_rate gauge`,
      `devtrack_error_rate ${snapshot.errorRate}`,
      ``,
      `# HELP devtrack_active_requests Current in-flight requests`,
      `# TYPE devtrack_active_requests gauge`,
      `devtrack_active_requests ${snapshot.activeRequests}`,
      ``,
      `# HELP devtrack_requests_per_second Requests per second`,
      `# TYPE devtrack_requests_per_second gauge`,
      `devtrack_requests_per_second ${snapshot.requestsPerSecond}`,
      ``,
      `# HELP devtrack_avg_latency_ms Average endpoint latency in ms`,
      `# TYPE devtrack_avg_latency_ms gauge`,
      `devtrack_avg_latency_ms ${snapshot.avgLatencyMs}`,
    ];

    // Per-endpoint metrics
    for (const [key, stats] of Object.entries(endpoints)) {
      const [method, ...pathParts] = key.split(':');
      const path = pathParts.join(':');
      const base = `devtrack_endpoint{method="${method}",path="${path}"}`;
      lines.push(
        `${base}_total ${stats.count}`,
        `${base}_errors ${stats.errors}`,
        `${base}_latency_avg_ms ${stats.totalLatencyMs > 0 ? Math.round(stats.totalLatencyMs / stats.count) : 0}`,
        `${base}_latency_max_ms ${stats.maxLatencyMs}`,
        `${base}_latency_p50_ms ${stats.p50LatencyMs}`,
        `${base}_latency_p95_ms ${stats.p95LatencyMs}`,
        `${base}_latency_p99_ms ${stats.p99LatencyMs}`,
      );
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  });

  app.get('/api/system/realtime-status', authMiddleware, adminMiddleware, (_req: AuthenticatedRequest, res: express.Response) => {
    const metrics = eventBus.getMetrics();
    res.json({ success: true, data: metrics });
  });

  app.get('/api/system/scheduler-status', authMiddleware, adminMiddleware, (_req: AuthenticatedRequest, res: express.Response) => {
    const snapshot = syncState.getSnapshot();
    res.json({
      success: true,
      data: {
        status: snapshot.status,
        totalSyncs: snapshot.totalSyncs,
        failedSyncs: snapshot.failedSyncs,
        lastSyncStartedAt: snapshot.lastSyncStartedAt,
        lastSyncCompletedAt: snapshot.lastSyncCompletedAt,
        lastSyncStatus: snapshot.lastSyncStatus,
        lastSyncDurationMs: snapshot.lastSyncDurationMs,
        currentlySyncing: snapshot.status === 'running',
      },
    });
  });

  app.get('/api/system/queue-status', authMiddleware, adminMiddleware, async (_req: AuthenticatedRequest, res: express.Response) => {
    const queueStatuses = await getRegisteredWorkerStatuses();

    const redisHealth = getRedisHealth();
    const workerStatus = getWorkerStatus();
    const xpWorkerStatus = getXpWorkerStatus();

    res.json({
      success: true,
      data: { redis: redisHealth, worker: workerStatus, xpWorker: xpWorkerStatus, queues: queueStatuses },
    });
  });

  app.get('/api/system/infrastructure', authMiddleware, adminMiddleware, (_req: AuthenticatedRequest, res: express.Response) => {
    const state = getInfrastructureState();
    res.json({ success: true, data: state });
  });

  app.get('/api/system/request-metrics', authMiddleware, adminMiddleware, (_req: AuthenticatedRequest, res: express.Response) => {
    const snapshot = getMetricsSnapshot();
    const endpoints = getEndpointLatencies();
    res.json({ success: true, data: { ...snapshot, endpoints } });
  });
}

bootstrap().catch((error) => {
  logger.error('Failed to start server', error);
  process.exit(1);
});
