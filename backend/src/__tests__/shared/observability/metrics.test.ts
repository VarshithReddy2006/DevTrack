import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  metricsMiddleware,
  metricsRegistry,
  renderMetrics,
  recordLlmTokens,
  parseRedisUsedMemory,
  hasValidMetricsToken,
} from '../../../shared/observability/metrics.js';
import { livenessHandler, readinessHandler, runReadiness } from '../../../shared/runtime/healthProbes.js';

let server: Server | undefined;

async function listen(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

describe('prometheus metrics', () => {
  it('records request duration under the route pattern, not the raw url', async () => {
    const app = express();
    app.use(metricsMiddleware);
    app.get('/things/:id', (_req, res) => { res.json({ ok: true }); });
    const base = await listen(app);
    await fetch(`${base}/things/42`);
    await fetch(`${base}/things/43`);
    await new Promise((r) => setTimeout(r, 20));

    const text = await renderMetrics();
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text).toMatch(/http_request_duration_seconds_count\{method="GET",route="\/things\/:id",status_code="200"\} 2/);
    expect(text).not.toContain('/things/42');
  });

  it('refreshes queue, sse and redis gauges from the supplied sources', async () => {
    const text = await renderMetrics({
      queues: async () => ({ 'xp-processing': { waiting: 7, active: 2 } }),
      sseConnections: () => ({ default: 3 }),
      redis: async () => ({ connected: true, usedMemoryBytes: 1024 }),
    });
    expect(text).toContain('bullmq_queue_waiting_jobs{queue="xp-processing"} 7');
    expect(text).toContain('bullmq_queue_active_jobs{queue="xp-processing"} 2');
    expect(text).toContain('sse_active_connections{tier="default"} 3');
    expect(text).toContain('redis_connection_status 1');
    expect(text).toContain('redis_used_memory_bytes 1024');
  });

  it('reports redis as down when the redis source throws, and still serves the scrape', async () => {
    const text = await renderMetrics({ redis: async () => { throw new Error('boom'); } });
    expect(text).toContain('redis_connection_status 0');
  });

  it('increments llm token usage and ignores bad counts', async () => {
    recordLlmTokens('gemini', 'flash', 'total', 120);
    recordLlmTokens('gemini', 'flash', 'total', 30);
    recordLlmTokens('gemini', 'flash', 'total', -5);
    recordLlmTokens('gemini', 'flash', 'total', Number.NaN);
    expect(await metricsRegistry.metrics()).toContain('llm_token_usage_total{provider="gemini",model="flash",type="total"} 150');
  });

  it('parses used_memory from INFO output', () => {
    expect(parseRedisUsedMemory('# Memory\r\nused_memory:2048\r\nused_memory_human:2K\r\n')).toBe(2048);
    expect(parseRedisUsedMemory('nothing here')).toBeUndefined();
  });

  it('only accepts the exact bearer token', () => {
    expect(hasValidMetricsToken('Bearer s3cret', 's3cret')).toBe(true);
    expect(hasValidMetricsToken('Bearer s3cret!', 's3cret')).toBe(false);
    expect(hasValidMetricsToken('Bearer s3cret', undefined)).toBe(false);
    expect(hasValidMetricsToken(undefined, 's3cret')).toBe(false);
    expect(hasValidMetricsToken('Basic s3cret', 's3cret')).toBe(false);
  });
});

describe('health probes', () => {
  const healthyRuntime = () => ({ eventLoopP99Ms: 4, heapUsedBytes: 50, heapTotalBytes: 100 });
  it('/healthz remains a lightweight liveness check without transient pressure gates', async () => {
    const app = express();
    app.get('/healthz', livenessHandler());
    const base = await listen(app);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  it('/readyz is 200 when every dependency answers', async () => {
    const app = express();
    app.get('/readyz', readinessHandler({
      pingMongo: async () => ({ ok: 1 }),
      pingRedis: async () => 'PONG',
      checkQueues: async () => [],
      readRuntime: healthyRuntime,
    }));
    const base = await listen(app);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', checks: { mongodb: 'up', redis: 'up', queues: 'up', eventLoop: 'up', heap: 'up' }, diagnostics: { ...healthyRuntime(), heapRatio: 0.5 } });
  });

  it('/readyz is 503 when mongo is offline', async () => {
    const app = express();
    app.get('/readyz', readinessHandler({
      pingMongo: async () => { throw new Error('connection refused'); },
      pingRedis: async () => 'PONG',
    }));
    const base = await listen(app);
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect((await res.json()).checks.mongodb).toBe('down');
  });

  it('sheds runtime pressure through HTTP readiness and recovers without failing liveness', async () => {
    const app = express();
    let runtime = healthyRuntime();
    app.get('/readyz', readinessHandler({ pingMongo: async () => true, readRuntime: () => runtime }));
    app.get('/healthz', livenessHandler());
    const base = await listen(app);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    runtime = { ...healthyRuntime(), eventLoopP99Ms: 700 };
    let response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    expect((await response.json()).checks.eventLoop).toBe('down');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    runtime = { ...healthyRuntime(), heapUsedBytes: 91 };
    response = await fetch(`${base}/readyz`);
    expect(response.status).toBe(503);
    expect((await response.json()).checks.heap).toBe('down');
    runtime = healthyRuntime();
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('/readyz is 503 when redis drops', async () => {
    const { ready, checks } = await runReadiness({
      pingMongo: async () => ({ ok: 1 }),
      pingRedis: async () => { throw new Error('ECONNRESET'); },
    });
    expect(ready).toBe(false);
    expect(checks.redis).toBe('down');
  });

  it('treats a hung dependency as down once the timeout passes', async () => {
    const { ready, checks } = await runReadiness({
      pingMongo: () => new Promise(() => undefined),
      timeoutMs: 30,
    });
    expect(ready).toBe(false);
    expect(checks.mongodb).toBe('down');
  });

  it('skips redis and queue checks when they are not configured', async () => {
    const { ready, checks } = await runReadiness({ pingMongo: async () => ({ ok: 1 }), readRuntime: healthyRuntime });
    expect(ready).toBe(true);
    expect(checks).toEqual({ mongodb: 'up', redis: 'skipped', queues: 'skipped', eventLoop: 'up', heap: 'up' });
  });
});
