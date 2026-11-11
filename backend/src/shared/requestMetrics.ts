// src/shared/requestMetrics.ts — API latency & request metrics
// Tracks request counts, latency histograms, and error rates per endpoint.
// Designed to be consumed by /metrics and health endpoints.

import { cacheManager } from './cache/cacheManager.js';
import type { Request, Response, NextFunction } from 'express';

export interface RequestMetric {
  method: string;
  path: string;
  statusCode: number;
  latencyMs: number;
  timestamp: number;
}

interface EndpointStats {
  count: number;
  errors: number;
  totalLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  lastSeen: number;
}

interface MetricsStore {
  requests: RequestMetric[];
  endpoints: Map<string, EndpointStats>;
  activeRequests: number;
  totalRequests: number;
  totalErrors: number;
  startedAt: number;
}

const store: MetricsStore = {
  requests: [],
  endpoints: new Map(),
  activeRequests: 0,
  totalRequests: 0,
  totalErrors: 0,
  startedAt: Date.now(),
};

const MAX_REQUEST_HISTORY = 1000;
const MAX_LATENCY_SAMPLES = 100;

interface LatencySamples {
  samples: number[];
}

const latencySamples = new Map<string, LatencySamples>();

function getEndpointKey(method: string, path: string): string {
  return `${method}:${path}`;
}

function updateEndpointStats(
  method: string,
  path: string,
  statusCode: number,
  latencyMs: number,
): void {
  const key = getEndpointKey(method, path);
  const now = Date.now();

  const existing = store.endpoints.get(key);
  if (existing) {
    existing.count++;
    existing.totalLatencyMs += latencyMs;
    existing.minLatencyMs = Math.min(existing.minLatencyMs, latencyMs);
    existing.maxLatencyMs = Math.max(existing.maxLatencyMs, latencyMs);
    existing.lastSeen = now;
    if (statusCode >= 400) existing.errors++;

    // Update percentiles from stored samples
    const s = latencySamples.get(key);
    if (s && s.samples.length > 0) {
      const sorted = [...s.samples].sort((a, b) => a - b);
      existing.p50LatencyMs = percentile(sorted, 0.5);
      existing.p95LatencyMs = percentile(sorted, 0.95);
      existing.p99LatencyMs = percentile(sorted, 0.99);
    }
  } else {
    store.endpoints.set(key, {
      count: 1,
      errors: statusCode >= 400 ? 1 : 0,
      totalLatencyMs: latencyMs,
      minLatencyMs: latencyMs,
      maxLatencyMs: latencyMs,
      p50LatencyMs: latencyMs,
      p95LatencyMs: latencyMs,
      p99LatencyMs: latencyMs,
      lastSeen: now,
    });
    latencySamples.set(key, { samples: [latencyMs] });
  }

  // Append latency sample (rolling window)
  const s = latencySamples.get(key);
  if (s) {
    s.samples.push(latencyMs);
    if (s.samples.length > MAX_LATENCY_SAMPLES) {
      s.samples.shift();
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return Math.round(sorted[idx]);
}

function recordRequest(metric: RequestMetric): void {
  store.requests.push(metric);
  if (store.requests.length > MAX_REQUEST_HISTORY) {
    store.requests.shift();
  }
  updateEndpointStats(metric.method, metric.path, metric.statusCode, metric.latencyMs);
}

export function requestMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  store.activeRequests++;
  store.totalRequests++;
  const startTime = Date.now();

  res.on('finish', () => {
    const latencyMs = Date.now() - startTime;
    store.activeRequests--;

    recordRequest({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      latencyMs,
      timestamp: now(),
    });

    if (res.statusCode >= 400) {
      store.totalErrors++;
    }
  });

  next();
}

function now(): number {
  return Date.now();
}

export interface MetricsSnapshot {
  cache: ReturnType<typeof cacheManager.getReadStats>;
  uptime: number;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  activeRequests: number;
  requestsPerSecond: number;
  avgLatencyMs: number;
  endpoints: Record<string, EndpointStats>;
  recentRequests: RequestMetric[];
}

export function getMetricsSnapshot(): MetricsSnapshot {
  const uptime = (Date.now() - store.startedAt) / 1000;
  const rps = uptime > 0 ? store.totalRequests / uptime : 0;

  // Compute global avg latency across all endpoints
  let totalLatency = 0;
  let totalCount = 0;
  for (const stats of store.endpoints.values()) {
    totalLatency += stats.totalLatencyMs;
    totalCount += stats.count;
  }
  const avgLatency = totalCount > 0 ? Math.round(totalLatency / totalCount) : 0;

  // Build endpoints object
  const endpoints: Record<string, EndpointStats> = {};
  for (const [key, stats] of store.endpoints) {
    endpoints[key] = { ...stats };
  }

  return {
    cache: cacheManager.getReadStats(),
    uptime: Math.floor(uptime),
    totalRequests: store.totalRequests,
    totalErrors: store.totalErrors,
    errorRate: store.totalRequests > 0
      ? Math.round((store.totalErrors / store.totalRequests) * 10000) / 100
      : 0,
    activeRequests: store.activeRequests,
    requestsPerSecond: Math.round(rps * 100) / 100,
    avgLatencyMs: avgLatency,
    endpoints,
    recentRequests: store.requests.slice(-50),
  };
}

export function getEndpointLatencies(): Record<string, EndpointStats> {
  const result: Record<string, EndpointStats> = {};
  for (const [key, stats] of store.endpoints) {
    result[key] = { ...stats };
  }
  return result;
}
