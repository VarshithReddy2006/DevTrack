import type { Attributes, SpanContext } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

// Raw URLs, database commands, exception messages, user payloads and span events can contain secrets.
const numericAttributes = new Set(['http.status_code', 'http.response.status_code', 'messaging.batch.message_count']);
const operationAttributes = new Set(['http.method', 'http.request.method', 'db.operation', 'db.operation.name', 'messaging.operation.type', 'bullmq.queue.operation', 'express.type']);

function sanitizeContext({ traceId, spanId, traceFlags, isRemote }: SpanContext): SpanContext {
  return { traceId, spanId, traceFlags, isRemote };
}

function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (numericAttributes.has(key) && typeof value === 'number') attributes[key] = value;
    if (operationAttributes.has(key) && typeof value === 'string' && /^[a-z_]{1,24}$/i.test(value)) attributes[key] = value;
  }
  const scope = span.instrumentationScope.name;
  const operation = span.name.split(' ', 1)[0];
  const name = scope === 'devtrack'
    ? span.name
    : scope === 'devtrack-bullmq'
      ? 'bullmq.' + (/^[a-z]{1,24}$/i.test(operation) ? operation : 'job')
      : scope.replace('@opentelemetry/instrumentation-', '');
  return {
    name,
    kind: span.kind,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: { name: scope, version: span.instrumentationScope.version },
    attributes,
    spanContext: () => sanitizeContext(span.spanContext()),
    parentSpanContext: span.parentSpanContext && sanitizeContext(span.parentSpanContext),
    events: [],
    links: span.links.map(link => ({ context: sanitizeContext(link.context) })),
    status: { code: span.status.code },
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

export function safeSpanExporter(exporter: SpanExporter): SpanExporter {
  return {
    export: (spans, callback) => exporter.export(spans.map(sanitizeSpan), callback),
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
  };
}
