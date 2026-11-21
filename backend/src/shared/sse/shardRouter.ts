// src/shared/sse/shardRouter.ts
// Deterministic hash sharding and stream key routing for horizontal SSE scaling

import { createHash } from 'node:crypto';

export const TOTAL_SHARDS = 16;
export const DEFAULT_STREAM_PREFIX = 'devtrack:sse:stream';

/**
 * Maps a userId deterministically to a shard index in [0, numShards - 1].
 * Uses SHA-256 for uniform hash-slot distribution across all shards.
 */
export function getShardForUser(userId: string, numShards = TOTAL_SHARDS): number {
  if (!userId || typeof userId !== 'string') {
    return 0;
  }
  const hashBuffer = createHash('sha256').update(userId).digest();
  const intVal = hashBuffer.readUInt32BE(0);
  return intVal % numShards;
}

/**
 * Returns the stream key with Redis Cluster hash tag for single-shard affinity.
 * E.g., devtrack:sse:stream:{0}, devtrack:sse:stream:{15}
 * Each shard lives on an independent Redis cluster slot to prevent single-node hotspots.
 */
export function getShardStreamKey(shardId: number, prefix = DEFAULT_STREAM_PREFIX): string {
  const normalized = Math.max(0, Math.floor(shardId)) % TOTAL_SHARDS;
  return `${prefix}:{${normalized}}`;
}

/**
 * Generates an instance-unique consumer group name for an API pod.
 * E.g., devtrack:sse:pod:<uuid>
 */
export function getStreamGroupForInstance(instanceId: string): string {
  return `devtrack:sse:pod:${instanceId}`;
}

/**
 * Parses a Redis Stream ID `<timestampMs>-<sequenceNumber>` into numeric components.
 */
export function parseStreamId(
  streamId: string | null | undefined
): { timestampMs: number; sequence: number } | null {
  if (!streamId || typeof streamId !== 'string') return null;
  const match = /^(\d+)-(\d+)$/.exec(streamId.trim());
  if (!match) return null;
  return {
    timestampMs: parseInt(match[1], 10),
    sequence: parseInt(match[2], 10),
  };
}

/**
 * Compares two Redis Stream IDs chronologically.
 * Returns negative if idA < idB, positive if idA > idB, and 0 if equal.
 */
export function compareStreamIds(idA: string, idB: string): number {
  const parsedA = parseStreamId(idA);
  const parsedB = parseStreamId(idB);

  if (!parsedA && !parsedB) return 0;
  if (!parsedA) return -1;
  if (!parsedB) return 1;

  if (parsedA.timestampMs !== parsedB.timestampMs) {
    return parsedA.timestampMs - parsedB.timestampMs;
  }
  return parsedA.sequence - parsedB.sequence;
}
