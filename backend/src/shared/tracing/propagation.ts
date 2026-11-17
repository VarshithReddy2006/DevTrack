import { context, ROOT_CONTEXT, trace, type Span, type SpanOptions, type TextMapPropagator, SpanStatusCode } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

// Only propagate W3C trace identifiers. Baggage can carry arbitrary application data.
const w3c = new W3CTraceContextPropagator();
export const traceContextPropagator: TextMapPropagator = {
  fields: () => ['traceparent'],
  inject: (parent, carrier, setter) => w3c.inject(parent, carrier, {
    set: (target, key, value) => { if (key === 'traceparent') setter.set(target, key, value); },
  }),
  extract: (parent, carrier, getter) => w3c.extract(parent, carrier, {
    keys: () => ['traceparent'],
    get: (source, key) => key === 'traceparent' ? getter.get(source, key) : undefined,
  }),
};
export interface TraceCarrier {
  traceparent?: string;
}

export function captureTraceContext(): TraceCarrier {
  const carrier: Record<string, string> = {};
  traceContextPropagator.inject(context.active(), carrier, { set: (target, key, value) => { target[key] = value; } });
  return carrier.traceparent ? { traceparent: carrier.traceparent } : {};
}

export function extractTraceContext(carrier: TraceCarrier) {
  return traceContextPropagator.extract(ROOT_CONTEXT, carrier, {
    keys: () => ['traceparent'],
    get: (source, key) => key === 'traceparent' && typeof source.traceparent === 'string' ? source.traceparent : undefined,
  });
}

export function withTraceContext<T>(carrier: TraceCarrier, fn: () => T): T {
  return context.with(extractTraceContext(carrier), fn);
}

export function startTraceOperation(name: string, carrier?: TraceCarrier, options?: SpanOptions): Span {
  return trace.getTracer('devtrack').startSpan(name, options, carrier ? extractTraceContext(carrier) : context.active());
}

export async function runTraceOperation<T>(name: string, fn: () => Promise<T>, carrier?: TraceCarrier): Promise<T> {
  const parent = carrier ? extractTraceContext(carrier) : context.active();
  return trace.getTracer('devtrack').startActiveSpan(name, {}, parent, async span => {
    try {
      return await fn();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
