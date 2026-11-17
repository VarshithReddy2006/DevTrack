// DevTrack HTTP server
import { shutdownTelemetry } from './instrumentation.js';
import { aiCredentialAction } from './config/aiCredentials.js';
import { createRequire } from 'node:module';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { env, API_BASE_PATH } from './config/index.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { requestContextMiddleware } from './middleware/requestContext.js';
import { tracingMiddleware } from './shared/tracing/tracing.js';
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
import { orchestrator, registerShutdownSignals } from './shared/runtime/index.js';
import { getInfrastructureState, setApiStatus, type InfrastructureState } from './shared/runtime/infrastructureRegistry.js';
import routes from './routes/index.js';
import { getRegisteredWorkerStatuses } from './shared/jobs/workers.js';
import { dlqRoutes } from './routes/dlq.routes.js';
import { registerPublicProfileShell } from './modules/profile/ogShell.routes.js';
import { mountApiRoutes } from './routes/mount.js';
import { sanitizeMongoError } from './db/connection.js';
import { discoverMigrations } from './db/migrations/discover.js';
import { createMigrationRunner } from './db/migrations/runner.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../package.json') as { version: string };

export async function createApp(): Promise<express.Express> {
  const app = express();

  app.use(requestContextMiddleware);
  app.use(tracingMiddleware);

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
    allowedHeaders: ['Content-Type', 'Authorization', 'traceparent', 'Idempotency-Key'],
    exposedHeaders: ['Content-Length', 'X-Request-ID', 'X-Trace-ID', 'X-Span-ID', 'Retry-After', 'Idempotent-Replayed'],
  }));

  app.use(morgan(':method :status :response-time ms'));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(sanitizeRequest);

  // Phase 2: Health & observability endpoints (before routes)
  setupHealthEndpoints(app, getRedisHealth, getWorkerStatus, getXpWorkerStatus, getOrCreateQueue, QueueNames, eventBus, syncState, getInfrastructureState);

  registerPublicProfileShell(app, env.CORS_ORIGIN, env.PUBLIC_API_URL || undefined);

  // Phase 3: API routes
  app.use('/api/system/dlq', dlqRoutes);
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

  const aiAction = aiCredentialAction({
    isProd: env.IS_PROD,
    corsOrigin: env.CORS_ORIGIN,
    hasOpenAi: Boolean(process.env.OPENAI_API_KEY),
    hasGemini: Boolean(env.GEMINI_API_KEY),
    requireAi: process.env.REQUIRE_AI_KEYS === 'true',
  });
  if (aiAction === 'exit') {
    logger.error('CRITICAL: At least one AI API key (OPENAI_API_KEY or GEMINI_API_KEY) must be set when REQUIRE_AI_KEYS is enabled');
    process.exit(1);
  } else if (aiAction === 'warn') {
    logger.warn('WARNING: No AI API keys set. Intelligence features will operate in degraded mode (deterministic fallbacks).');
    logger.warn('Set OPENAI_API_KEY or GEMINI_API_KEY for full intelligence capabilities.');
  }

  if (env.IS_PROD) {
    const migrations = await discoverMigrations();
    const connection = mongoose.createConnection(env.MONGODB_URI, {
      autoCreate: false,
      autoIndex: false,
      serverSelectionTimeoutMS: 10000,
    });
    try {
      await connection.asPromise();
      await createMigrationRunner(connection, migrations).check();
    } catch (error) {
      throw new Error(sanitizeMongoError(error instanceof Error ? error.message : String(error)));
    } finally {
      await connection.close();
    }
  }

  const app = await createApp();

  // Phase 6: HTTP server start (bind explicitly to 0.0.0.0 and env.PORT before orchestrator)
  const host = process.env.HOST || '0.0.0.0';
  const server = app.listen(env.PORT, host, () => {
    logger.info(`DevTrack backend listening on ${host}:${env.PORT}`);
    logger.info(`Environment: ${env.NODE_ENV}`);
    logger.info(`API base path: ${API_BASE_PATH}`);
    logger.info(`AI Provider: ${process.env.OPENAI_API_KEY ? 'OpenAI configured' : env.GEMINI_API_KEY ? 'Gemini configured' : 'None (degraded mode)'}`);
  });

  server.on('error', (err: unknown) => {
    logger.error('CRITICAL: HTTP server failed to bind or listen', err);
    process.exit(1);
  });

  registerShutdownSignals(server, shutdownTelemetry);

  // Phase 6.5: Start orchestrator in background (non-blocking)
  orchestrator.startup(app).catch((err) => {
    logger.error('Orchestrator startup failed (server still running in degraded mode)', err);
    setApiStatus('failed', err instanceof Error ? err.message : String(err));
  });
}

// ---------------------------------------------------------------------------
// Health & system endpoints
// ---------------------------------------------------------------------------

export function setupHealthEndpoints(
  app: express.Express,
  getRedisHealth: () => { status: string; host: string; port: number; lastError: string | null; reconnectAttempts: number },
  getWorkerStatus: () => { running: boolean },
  getXpWorkerStatus: () => { running: boolean },
  getOrCreateQueue: (name: string) => { getJobCounts(): Promise<{ active?: number; waiting?: number; failed?: number; completed?: number; delayed?: number }> },
  QueueNames: { PLATFORM_SYNC: string; SYSTEM_MAINTENANCE: string; XP_PROCESSING: string; STREAK_RECALC: string; NOTIFICATIONS: string },
  eventBus: { getMetrics(): { activeConnections: number; totalConnections: number; totalDisconnects: number; totalReconnects: number; heartbeatFailures: number; eventsPublished: number; uptimeSeconds: number } },
  syncState: { getSnapshot(): { status: string; lastSyncStartedAt: string | null; lastSyncCompletedAt: string | null; lastSyncStatus: 'success' | 'partial' | 'failed' | null; lastSyncDurationMs: number | null; totalSyncs: number; failedSyncs: number } },
  getInfrastructureState: () => InfrastructureState,
): void {
  // Liveness probe — process is alive and responding
  app.get('/health/live', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Readiness probe — application is ready to accept user traffic
  app.get('/health/ready', (_req, res) => {
    try {
      const state = getInfrastructureState();
      const mongoState = mongoose.connection?.readyState ?? 0;
      const mongoLabels: Record<number, string> = {
        0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting',
      };
      const mongoReady = state.mongodb.status === 'healthy' && mongoState !== 0;
      const apiReady = state.api.status === 'healthy';
      const isReady = mongoReady && apiReady;

      res.status(isReady ? 200 : 503).json({
        status: isReady ? 'ok' : 'unhealthy',
        ready: isReady,
        timestamp: new Date().toISOString(),
        checks: {
          mongodb: mongoReady ? 'connected' : (state.mongodb.status || 'disconnected'),
          mongodbState: mongoLabels[mongoState] ?? 'unknown',
          mongodbReadyState: mongoState,
          ...(state.mongodb.error ? { mongodbError: sanitizeMongoError(state.mongodb.error) } : {}),
          api: state.api.status,
          ...(state.api.error ? { apiError: state.api.error } : {}),
        },
      });
    } catch (err) {
      res.status(503).json({
        status: 'unhealthy',
        ready: false,
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'Readiness check failed',
      });
    }
  });

  // Primary health check — overall service health, compatible with Render and frontend
  app.get('/health', (_req, res) => {
    try {
      const state = getInfrastructureState();
      const mongoState = mongoose.connection?.readyState ?? 0;
      const mongoLabels: Record<number, string> = {
        0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting',
      };
      const mongoReady = state.mongodb.status === 'healthy' && mongoState !== 0;
      const apiReady = state.api.status === 'healthy';
      const isCriticalHealthy = mongoReady && apiReady;

      const statusCode = isCriticalHealthy ? 200 : 503;

      res.status(statusCode).json({
        status: isCriticalHealthy ? (state.degraded ? 'degraded' : 'ok') : 'unhealthy',
        timestamp: new Date().toISOString(),
        environment: env.NODE_ENV,
        degraded: state.degraded,
        degradedComponents: state.degradedComponents,
        checks: {
          mongodb: mongoReady ? 'connected' : (state.mongodb.status || 'disconnected'),
          mongodbState: mongoLabels[mongoState] ?? 'unknown',
          mongodbReadyState: mongoState,
          ...(state.mongodb.error ? { mongodbError: sanitizeMongoError(state.mongodb.error) } : {}),
          api: state.api.status,
          ...(state.api.error ? { apiError: state.api.error } : {}),
        },
      });
    } catch (err) {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        environment: env.NODE_ENV,
        degraded: true,
        degradedComponents: ['api'],
        checks: {
          api: 'failed',
          apiError: err instanceof Error ? err.message : 'Health check failed',
        },
      });
    }
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

if (process.env.NODE_ENV !== 'test') {
  bootstrap().catch((error) => {
    logger.error('Failed to start server', error);
    process.exit(1);
  });
}
