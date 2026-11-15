// src/shared/tracing/tracing.ts — Distributed Tracing Preparation
// Phase-B: OpenTelemetry-ready architecture with async-local-storage

import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { context as otelContext, isSpanContextValid, trace, SpanKind } from '@opentelemetry/api';
import { startTraceOperation } from './propagation.js';

// Trace context storage
const traceStorage = new AsyncLocalStorage<TraceContext>();

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  correlationId: string;
  userId?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// Trace span for timing operations
export interface Span {
  name: string;
  startTime: number;
  endTime?: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

const spanStorage = new AsyncLocalStorage<Span[]>();

// ─── Core tracing functions ─────────────────────────────────────────────

export function startTrace(): TraceContext {
  const traceId = randomUUID().replaceAll('-', '');
  const spanId = randomUUID().replaceAll('-', '').slice(0, 16);

  const context: TraceContext = {
    traceId,
    spanId,
    correlationId: traceId,
    timestamp: Date.now(),
  };

  return context;
}

export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function runInTrace<T>(context: TraceContext, fn: () => Promise<T>): Promise<T> {
  return traceStorage.run(context, () => spanStorage.run([], fn));
}

// Span management
export function startSpan(name: string): void {
  const spans = spanStorage.getStore();
  if (spans) {
    spans.push({
      name,
      startTime: Date.now(),
    });
  }
}

export function endSpan(name: string, metadata?: Record<string, unknown>, error?: string): void {
  const spans = spanStorage.getStore();
  if (spans) {
    const span = spans.find((s) => s.name === name && !s.endTime);
    if (span) {
      span.endTime = Date.now();
      span.metadata = metadata;
      span.error = error;
    }
  }
}

export function getActiveSpans(): Span[] {
  return spanStorage.getStore() || [];
}

// Span timing helper
export async function traceSpan<T>(
  name: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  startSpan(name);
  try {
    const result = await fn();
    endSpan(name, metadata);
    return result;
  } catch (err) {
    endSpan(name, metadata, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function syncTraceSpan<T>(
  name: string,
  fn: () => T,
  metadata?: Record<string, unknown>
): T {
  startSpan(name);
  try {
    const result = fn();
    endSpan(name, metadata);
    return result;
  } catch (err) {
    endSpan(name, metadata, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// ─── Request correlation middleware ───────────────────────────────────────

import type { Request, Response, NextFunction } from 'express';

export function tracingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const active = trace.getActiveSpan();
  const span = active ?? startTraceOperation('http.request', {
    traceparent: req.get('traceparent'),
  }, { kind: SpanKind.SERVER });
  if (!active) {
    res.once('finish', () => span.end());
    res.once('close', () => { if (!res.writableFinished) span.end(); });
  }

  const ids = span.spanContext();
  const requestTrace = isSpanContextValid(ids)
    ? { traceId: ids.traceId, spanId: ids.spanId, correlationId: req.context?.requestId ?? ids.traceId, timestamp: Date.now() }
    : startTrace();
  req.traceContext = requestTrace;
  res.setHeader('X-Trace-ID', requestTrace.traceId);
  res.setHeader('X-Span-ID', requestTrace.spanId);
  otelContext.with(trace.setSpan(otelContext.active(), span), () => {
    traceStorage.run(requestTrace, () => spanStorage.run([], next));
  });
}

// Add user context to trace
export function setUserContext(userId: string, metadata?: Record<string, unknown>): void {
  const context = getTraceContext();
  if (context) {
    context.userId = userId;
    context.metadata = { ...context.metadata, ...metadata };
  }
}

// ─── Queue job propagation ──────────────────────────────────────────────

export function injectTraceIntoJob(jobData: Record<string, unknown>): Record<string, unknown> {
  const { traceId, spanId, correlationId } = getTraceMetadata();
  if (!traceId) return jobData;

  // Preserve the payload format for workers during mixed-version deployments.
  return {
    ...jobData,
    _trace: { traceId, spanId, parentSpanId: getTraceContext()?.parentSpanId, correlationId: correlationId ?? traceId },
  };
}

export function extractTraceFromJob(jobData: Record<string, unknown>): TraceContext | undefined {
  const trace = jobData._trace as Record<string, string> | undefined;
  if (!trace) return undefined;

  return {
    traceId: trace.traceId,
    spanId: trace.spanId,
    parentSpanId: trace.parentSpanId,
    correlationId: trace.correlationId,
    timestamp: Date.now(),
  };
}

// Run job processor within trace context
export async function runJobInTrace<T>(
  jobData: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const trace = extractTraceFromJob(jobData);
  if (!trace) {
    return fn();
  }

  const context: TraceContext = {
    ...trace,
    parentSpanId: trace.spanId,
    spanId: randomUUID().replaceAll('-', '').slice(0, 16),
    timestamp: Date.now(),
  };

  return runInTrace(context, fn);
}

// ─── SSE trace continuity ───────────────────────────────────────────────

export function createSseTraceContext(): TraceContext {
  return startTrace();
}

// ─── Logging integration ──────────────────────────────────────────────────

export function getTraceMetadata(): Record<string, string> {
  const context = getTraceContext();
  const active = trace.getSpanContext(otelContext.active());
  const ids = active && isSpanContextValid(active) ? active : context;
  if (!ids) return {};
  return {
    traceId: ids.traceId,
    spanId: ids.spanId,
    ...(context && { correlationId: context.correlationId }),
    ...(context?.userId && { userId: context.userId }),
  };
}

// Express request extension
declare global {
  namespace Express {
    interface Request {
      traceContext?: TraceContext;
    }
  }
}

export default {
  startTrace,
  getTraceContext,
  runInTrace,
  startSpan,
  endSpan,
  traceSpan,
  syncTraceSpan,
  tracingMiddleware,
  setUserContext,
  injectTraceIntoJob,
  extractTraceFromJob,
  runJobInTrace,
  createSseTraceContext,
  getTraceMetadata,
};