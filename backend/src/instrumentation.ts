import { register } from 'node:module';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { MongooseInstrumentation } from '@opentelemetry/instrumentation-mongoose';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOffSampler, BatchSpanProcessor, NoopSpanProcessor } from '@opentelemetry/sdk-trace';
import { traceContextPropagator } from './shared/tracing/propagation.js';
import { safeSpanExporter } from './shared/tracing/safeSpanExporter.js';

function startTelemetry() {
  if (process.env.OTEL_SDK_DISABLED === 'true' || process.env.NODE_ENV === 'test') return undefined;

  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  const exportEnabled = Boolean(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'devtrack-backend',
    textMapPropagator: traceContextPropagator,
    autoDetectResources: false,
    metricReaders: [],
    logRecordProcessors: [],
    spanProcessors: [exportEnabled
      ? new BatchSpanProcessor({ exporter: safeSpanExporter(new OTLPTraceExporter()) })
      : new NoopSpanProcessor()],
    ...(exportEnabled ? {} : { sampler: new AlwaysOffSampler() }),
    instrumentations: [
      new HttpInstrumentation({ disableOutgoingRequestInstrumentation: true }),
      new ExpressInstrumentation(),
      new MongooseInstrumentation({ dbStatementSerializer: () => '' }),
      new IORedisInstrumentation({ dbStatementSerializer: () => '' }),
    ],
  });
  sdk.start();
  return sdk;
}

const sdk = startTelemetry();

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
