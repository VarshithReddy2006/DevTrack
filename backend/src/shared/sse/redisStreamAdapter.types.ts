// src/shared/sse/redisStreamAdapter.types.ts
// Type definitions for Redis Stream Consumer Group adapter & Shard Routing

import { SseEventType } from './eventBus.js';

export interface ShardedStreamEvent {
  id?: string;
  origin: string;
  userId: string;
  type: SseEventType;
  sequence: number;
  timestamp: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  schemaVersion?: number;
}

export interface RedisStreamAdapterConfig {
  /** Total number of hash shards across the cluster (default 16) */
  numShards?: number;
  /** Stream prefix before shard index tag (default 'devtrack:sse:stream') */
  streamPrefix?: string;
  /** Max stream length retention before trim (default 10,000) */
  maxLen?: number;
  /** Batch count for XREADGROUP (default 50) */
  batchSize?: number;
  /** Block duration in ms for XREADGROUP (default 1,000) */
  blockMs?: number;
  /** Grace period in ms before destroying empty shard consumer group (default 30,000) */
  hysteresisMs?: number;
}

export interface ShardSubscriptionStats {
  shardId: number;
  refCount: number;
  status: 'inactive' | 'activating' | 'active' | 'draining';
  isDraining: boolean;
  messagesReceived: number;
  messagesAcked: number;
}

export interface ShardedAdapterMetrics {
  instanceId: string;
  activeShards: number;
  totalSubscribedUsers: number;
  totalEventsPublished: number;
  totalEventsDelivered: number;
  shards: ShardSubscriptionStats[];
}
