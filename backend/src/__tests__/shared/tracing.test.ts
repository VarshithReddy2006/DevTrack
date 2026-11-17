import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { SpanKind, trace as bullTrace } from 'bullmq';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { logger } from '../../shared/logger.js';
import { captureTraceContext, traceContextPropagator, withTraceContext } from '../../shared/tracing/propagation.js';
import { getQueueTelemetry } from '../../shared/tracing/queueTelemetry.js';
import { safeSpanExporter } from '../../shared/tracing/safeSpanExporter.js';
import { tracingMiddleware } from '../../shared/tracing/tracing.js';

vi.unmock('bullmq');

const exporter = new InMemorySpanExporter();
const sdk = new NodeSDK({
  autoDetectResources: false,
  textMapPropagator: traceContextPropagator,
  metricReaders: [],
  logRecordProcessors: [],
  spanProcessors: [new SimpleSpanProcessor({ exporter: safeSpanExporter(exporter) })],
});

beforeAll(() => sdk.start());
afterAll(async () => {
  await sdk.shutdown();
  trace.disable();
  propagation.disable();
  context.disable();
});
afterEach(() => {
  exporter.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('restores a persisted W3C parent across BullMQ and correlates the worker log', async () => {
  vi.stubEnv('DEBUG', 'true');
  vi.stubEnv('SILENT_LOGGING', 'false');
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const parentTrace = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  const req = {
    get: (key: string) => key === 'traceparent' ? parentTrace : undefined,
    context: { requestId: 'request-42' },
  } as Request;
  const res = Object.assign(new EventEmitter(), { setHeader: vi.fn() }) as unknown as Response;
  let row = '';
  tracingMiddleware(req, res, () => { row = JSON.stringify(captureTraceContext()); });
  res.emit('finish');

  const traceId = parentTrace.split('-')[1];
  expect(req.traceContext?.traceId).toBe(traceId);
  expect(JSON.parse(row)).toEqual({ traceparent: expect.stringContaining(traceId) });
  expect(res.setHeader).toHaveBeenCalledWith('X-Trace-ID', traceId);

  const metadata = await withTraceContext(JSON.parse(row), () => bullTrace(
    getQueueTelemetry(), SpanKind.PRODUCER, 'sync', 'add', 'platform-sync',
    async (_span, carrier) => carrier,
  ));
  expect(JSON.parse(metadata!)).toEqual({ traceparent: expect.stringContaining(traceId) });

  const workerIds = await bullTrace(
    getQueueTelemetry(), SpanKind.CONSUMER, 'sync', 'process', 'platform-sync',
    async () => {
      logger.info('Processed job', { queue: 'platform-sync' });
      return trace.getActiveSpan()?.spanContext();
    },
    metadata,
  );
  expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toMatchObject({
    traceId, spanId: workerIds?.spanId, event: 'Processed job',
  });
  const spans = exporter.getFinishedSpans();
  const request = spans.find(span => span.name === 'http.request');
  const producer = spans.find(span => span.name === 'bullmq.add');
  const consumer = spans.find(span => span.name === 'bullmq.process');
  expect(request?.parentSpanContext?.spanId).toBe('0123456789abcdef');
  expect(producer?.parentSpanContext?.spanId).toBe(request?.spanContext().spanId);
  expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
});

it('rejects invalid traceparents and discards incoming baggage and tracestate', () => {
  withTraceContext({ traceparent: 'not-a-trace' }, () => expect(captureTraceContext()).toEqual({}));

  const traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  const incoming = { traceparent, tracestate: 'vendor=private-text', baggage: 'token=private-token' };
  const carrier = {};
  propagation.inject(propagation.extract(context.active(), incoming), carrier);
  expect(carrier).toEqual({ traceparent });
});

it('filters private attributes, exception data and log metadata', () => {
  vi.stubEnv('DEBUG', 'true');
  vi.stubEnv('SILENT_LOGGING', 'false');
  const output = vi.spyOn(console, 'error').mockImplementation(() => {});
  const tracer = trace.getTracer('@opentelemetry/instrumentation-http');
  const secret = 'private-resume-sentence';
  tracer.startActiveSpan('GET /api/events?token=' + secret, span => {
    span.setAttributes({ 'http.status_code': 500, 'url.full': secret, 'db.query.text': secret });
    span.recordException(new Error(secret));
    span.setStatus({ code: 2, message: secret });
    logger.error('Upstream failed', new Error(secret), {
      input: { resumeText: secret, headers: { authorization: secret }, prompt: secret },
      url: 'https://example.test/events?token=' + secret,
      upstream: 'Authorization: Bearer ' + secret,
    });
    span.end();
  });

  const line = output.mock.calls[0][0];
  expect(line).not.toContain(secret);
  expect(JSON.parse(line)).toMatchObject({ error: 'Error', metadata: { input: { resumeText: '[REDACTED]' } } });
  const [span] = exporter.getFinishedSpans();
  expect(span).toMatchObject({ name: 'http', attributes: { 'http.status_code': 500 }, events: [], status: { code: 2 } });
  expect(JSON.stringify(span)).not.toContain(secret);
});
