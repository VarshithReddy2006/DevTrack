// src/shared/sse/index.ts — SSE module barrel export
export { eventBus, EventBus } from './eventBus.js';
export type {
  SseClient,
  SseEvent,
  SseEventType,
  SseMetricsSnapshot,
  SseEventEnvelope,
  EventBusOptions,
} from './eventBus.js';
export { handleSseRequest } from './sseHandler.js';