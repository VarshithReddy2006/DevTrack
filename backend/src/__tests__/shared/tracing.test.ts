import { context, propagation, trace } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { SpanKind, trace as bullTrace } from 'bullmq';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { OutboxEvent } from '../../db/models/outboxEvent.model.js';
import { runInTransaction } from '../../db/transaction.js';
import { writeOutboxEvent } from '../../shared/events/outbox.js';
import { OutboxRelay } from '../../shared/events/outboxRelay.js';
import { runConsumer } from '../../shared/events/runConsumer.js';
import { logger } from '../../shared/logger.js';
import { captureTraceContext, traceContextPropagator, withTraceContext } from '../../shared/tracing/propagation.js';
import { getQueueTelemetry } from '../../shared/tracing/queueTelemetry.js';
import { safeSpanExporter } from '../../shared/tracing/safeSpanExporter.js';
import { tracingMiddleware } from '../../shared/tracing/tracing.js';

vi.unmock('bullmq');

const exporter = new InMemorySpanExporter();
const eventInput = {
  type: 'focus.session.completed',
  aggregateType: 'focus_session',
  aggregateId: 'session-42',
  userId: 'user-42',
  payload: { minutes: 25 },
};
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

it('preserves the request trace across a MongoDB outbox row, BullMQ and the consumer log', async () => {
  vi.stubEnv('DEBUG', 'true');
  vi.stubEnv('SILENT_LOGGING', 'false');
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const parentTrace = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
  const req = {
    get: (key: string) => key === 'traceparent' ? parentTrace : undefined,
    context: { requestId: 'request-42' },
  } as Request;
  const res = Object.assign(new EventEmitter(), { setHeader: vi.fn() }) as unknown as Response;
  let pending: ReturnType<typeof writeOutboxEvent> | undefined;
  tracingMiddleware(req, res, () => {
    pending = runInTransaction(session => writeOutboxEvent(session, {
      ...eventInput,
      traceContext: {
        traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
        correlationId: 'request-42',
        baggage: 'authorization=private-token',
        tracestate: 'vendor=private-resume',
        resumeText: 'private-resume',
      },
    }));
  });
  const persisted = await pending!;
  res.emit('finish');

  const traceId = parentTrace.split('-')[1];
  expect(req.traceContext?.traceId).toBe(traceId);
  const row = await OutboxEvent.findOne({ eventId: persisted.eventId }).lean();
  expect(row?.traceContext).toEqual({ traceparent: expect.stringContaining(traceId), correlationId: 'request-42' });
  expect(res.setHeader).toHaveBeenCalledWith('X-Trace-ID', traceId);

  let workerIds: ReturnType<typeof trace.getSpanContext>;
  const relay = new OutboxRelay({
    resolveQueues: () => ['domain-readiness'],
    enqueue: async (queue, jobId, envelope) => {
      expect(jobId).toBe(persisted.eventId);
      expect(envelope.correlationId).toBe('request-42');
      const metadata = await bullTrace(
        getQueueTelemetry(), SpanKind.PRODUCER, 'focus', 'add', queue,
        async (_span, carrier) => carrier,
      );
      expect(JSON.parse(metadata!)).toEqual({ traceparent: expect.stringContaining(traceId) });

      await bullTrace(
        getQueueTelemetry(), SpanKind.CONSUMER, 'focus', 'process', queue,
        () => runConsumer({
          name: 'trace-regression',
          dedup: 'natural',
          async handle() {
            workerIds = trace.getActiveSpan()?.spanContext();
            logger.info('Processed job', { queue });
          },
        }, envelope),
        metadata,
      );
    },
  });
  expect(await relay.tick()).toBe(1);
  expect((await OutboxEvent.findOne({ eventId: persisted.eventId }))?.status).toBe('published');
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

it('uses a valid explicit parent for background writes and isolates old rows from the relay caller', async () => {
  const traceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
  const traced = await runInTransaction(session => writeOutboxEvent(session, {
    ...eventInput, traceContext: { traceparent, causationId: 'parent-event' },
  }));
  expect(traced.traceContext).toEqual({ traceparent, causationId: 'parent-event' });
  const oldRow = await runInTransaction(session => writeOutboxEvent(session, eventInput));
  await OutboxEvent.updateOne({ eventId: oldRow.eventId }, { $set: { traceContext: { traceparent: 'invalid' } } });

  const observed = new Map<string, ReturnType<typeof captureTraceContext>>();
  const relay = new OutboxRelay({
    resolveQueues: () => ['domain-readiness'],
    enqueue: async (_queue, jobId) => { observed.set(jobId, captureTraceContext()); },
  });
  await withTraceContext({ traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
    () => relay.tick());

  expect(observed.get(traced.eventId)).toEqual({ traceparent });
  expect(observed.get(oldRow.eventId)).toEqual({});
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
