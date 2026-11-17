import { BullMQOtel } from 'bullmq-otel';
let telemetry: BullMQOtel | undefined;

export function getQueueTelemetry(): BullMQOtel {
  telemetry ??= new BullMQOtel('devtrack-bullmq');
  return telemetry;
}
