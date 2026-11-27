const otelEnabled =
  process.env.OTEL_SDK_DISABLED !== 'true' &&
  process.env.NODE_ENV !== 'test' &&
  (Boolean(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT) ||
    process.env.OTEL_FORCE_ENABLE === 'true');

async function startTelemetry() {
  if (!otelEnabled) return undefined;

  const [
    { register },
    { OTLPTraceExporter },
    { ExpressInstrumentation },
    { HttpInstrumentation },
    { IORedisInstrumentation },
    { MongooseInstrumentation },
    { NodeSDK },
    { AlwaysOffSampler, BatchSpanProcessor, NoopSpanProcessor },
    { traceContextPropagator },
    { safeSpanExporter },
  ] = await Promise.all([
    import('node:module'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/instrumentation-express'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-ioredis'),
    import('@opentelemetry/instrumentation-mongoose'),
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/sdk-trace'),
    import('./shared/tracing/propagation.js'),
    import('./shared/tracing/safeSpanExporter.js'),
  ]);

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

const sdk = await startTelemetry();

export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
}
