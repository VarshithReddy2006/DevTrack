// src/shared/observability/metrics.ts — Prometheus registry and collectors for /metrics
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: 'devtrack_' });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const queueWaitingJobs = new Gauge({
  name: 'bullmq_queue_waiting_jobs',
  help: 'Jobs waiting in a BullMQ queue',
  labelNames: ['queue'] as const,
  registers: [metricsRegistry],
});

export const queueActiveJobs = new Gauge({
  name: 'bullmq_queue_active_jobs',
  help: 'Jobs currently being processed in a BullMQ queue',
  labelNames: ['queue'] as const,
  registers: [metricsRegistry],
});

export const sseActiveConnections = new Gauge({
  name: 'sse_active_connections',
  help: 'Open server-sent-event connections',
  labelNames: ['tier'] as const,
  registers: [metricsRegistry],
});

export const redisConnectionStatus = new Gauge({
  name: 'redis_connection_status',
  help: '1 when the Redis connection is ready, 0 otherwise',
  registers: [metricsRegistry],
});

export const redisUsedMemoryBytes = new Gauge({
  name: 'redis_used_memory_bytes',
  help: 'Memory used by Redis as reported by INFO memory',
  registers: [metricsRegistry],
});

export const llmTokenUsage = new Counter({
  name: 'llm_token_usage_total',
  help: 'LLM tokens consumed',
  labelNames: ['provider', 'model', 'type'] as const,
  registers: [metricsRegistry],
});

export const leagueSagaRollbacks = new Counter({
  name: 'league_saga_rollbacks_total',
  help: 'Total weekly league rollover saga rollbacks triggered',
  labelNames: ['phase', 'division', 'step'] as const,
  registers: [metricsRegistry],
});

export function recordLlmTokens(provider: string, model: string, type: 'prompt' | 'completion' | 'total', tokens: number): void {
  if (Number.isFinite(tokens) && tokens > 0) llmTokenUsage.inc({ provider, model, type }, tokens);
}

/** Use the matched route pattern, never the raw URL, so ids cannot blow up label cardinality. */
export function routeLabel(req: Pick<Request, 'baseUrl' | 'route'>): string {
  const pattern = req.route?.path;
  if (typeof pattern !== 'string') return 'unmatched';
  return `${req.baseUrl ?? ''}${pattern}` || '/';
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe(
      { method: req.method, route: routeLabel(req), status_code: String(res.statusCode) },
      seconds,
    );
  });
  next();
}

export interface MetricsSources {
  queues?: () => Promise<Record<string, { waiting?: number; active?: number }>>;
  sseConnections?: () => Record<string, number>;
  redis?: () => Promise<{ connected: boolean; usedMemoryBytes?: number }>;
}

/** Pull-style gauges are refreshed right before each scrape. A failing source never breaks the scrape. */
export async function renderMetrics(sources: MetricsSources = {}): Promise<string> {
  if (sources.queues) {
    try {
      const counts = await sources.queues();
      for (const [queue, c] of Object.entries(counts)) {
        queueWaitingJobs.set({ queue }, c.waiting ?? 0);
        queueActiveJobs.set({ queue }, c.active ?? 0);
      }
    } catch { /* leave the last values in place */ }
  }
  if (sources.sseConnections) {
    sseActiveConnections.reset();
    for (const [tier, n] of Object.entries(sources.sseConnections())) sseActiveConnections.set({ tier }, n);
  }
  if (sources.redis) {
    try {
      const r = await sources.redis();
      redisConnectionStatus.set(r.connected ? 1 : 0);
      if (r.usedMemoryBytes !== undefined) redisUsedMemoryBytes.set(r.usedMemoryBytes);
    } catch {
      redisConnectionStatus.set(0);
    }
  }
  return metricsRegistry.metrics();
}

/** Parse `used_memory:123` out of an INFO memory payload. */
export function parseRedisUsedMemory(info: string): number | undefined {
  const m = /^used_memory:(\d+)/m.exec(info);
  return m ? Number(m[1]) : undefined;
}

/** True when the Authorization header carries exactly the configured scrape token. */
export function hasValidMetricsToken(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}
