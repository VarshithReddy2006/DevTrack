// src/shared/sse/redisStreamAdapter.ts
// Redis Stream Consumer Group Adapter with Hash-Sharded Channels for Horizontal SSE Scaling

import { EventEmitter } from 'node:events';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';
import {
  createRedisConnection,
  getRedisClient,
  getRedisHealth,
  isRedisConfigured,
} from '../redis/client.js';
import {
  TOTAL_SHARDS,
  DEFAULT_STREAM_PREFIX,
  getShardForUser,
  getShardStreamKey,
  getStreamGroupForInstance,
} from './shardRouter.js';
import type {
  RedisStreamAdapterConfig,
  ShardSubscriptionStats,
  ShardedAdapterMetrics,
  ShardedStreamEvent,
} from './redisStreamAdapter.types.js';

interface InternalShardState {
  shardId: number;
  refCount: number;
  status: 'inactive' | 'activating' | 'active' | 'draining';
  activationPromise: Promise<void> | null;
  drainTimer: NodeJS.Timeout | null;
  readerRunning: boolean;
  messagesReceived: number;
  messagesAcked: number;
}

export class RedisStreamAdapter extends EventEmitter {
  readonly instanceId: string;
  readonly groupName: string;
  readonly consumerName: string;

  private readonly numShards: number;
  private readonly streamPrefix: string;
  private readonly maxLen: number;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly hysteresisMs: number;

  private readonly shardStates = new Map<number, InternalShardState>();
  private readonly userShardMap = new Map<string, number>();

  private dedicatedRedisClient: Redis | null = null;
  private customRedisClient?: Redis;
  private stopped = false;

  private totalEventsPublished = 0;
  private totalEventsDelivered = 0;

  constructor(
    instanceId: string,
    config: RedisStreamAdapterConfig = {},
    customRedisClient?: Redis
  ) {
    super();
    this.instanceId = instanceId;
    this.groupName = getStreamGroupForInstance(instanceId);
    this.consumerName = `reader-${instanceId.slice(0, 8)}`;

    this.numShards = config.numShards ?? TOTAL_SHARDS;
    this.streamPrefix = config.streamPrefix ?? DEFAULT_STREAM_PREFIX;
    this.maxLen = config.maxLen ?? 10_000;
    this.batchSize = config.batchSize ?? 50;
    this.blockMs = config.blockMs ?? 1_000;
    this.hysteresisMs = config.hysteresisMs ?? 30_000; // 30s hysteresis

    this.customRedisClient = customRedisClient;

    // Initialize state structures for all shards
    for (let s = 0; s < this.numShards; s++) {
      this.shardStates.set(s, {
        shardId: s,
        refCount: 0,
        status: 'inactive',
        activationPromise: null,
        drainTimer: null,
        readerRunning: false,
        messagesReceived: 0,
        messagesAcked: 0,
      });
    }
  }

  /**
   * Returns the Redis client used for reader loops and metadata management.
   */
  private getRedis(): Redis {
    if (this.customRedisClient) {
      return this.customRedisClient;
    }
    if (!this.dedicatedRedisClient) {
      if (!isRedisConfigured()) {
        return getRedisClient();
      }
      this.dedicatedRedisClient = createRedisConnection({
        lazyConnect: true,
        family: 0,
        retryStrategy(times: number) {
          return Math.min(times * 100, 3000);
        },
      });
      this.dedicatedRedisClient.on('error', (err: Error) => {
        logger.warn('[redis-stream-adapter] Dedicated connection error', { error: err.message });
      });
      void this.dedicatedRedisClient.connect().catch((err: unknown) => {
        logger.warn('[redis-stream-adapter] Connect error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return this.dedicatedRedisClient;
  }

  /**
   * Registers a user connection, deterministically mapping to its shard
   * and incrementing the shard's active subscriber reference count.
   */
  async registerUser(userId: string): Promise<number> {
    if (this.stopped) throw new Error('RedisStreamAdapter is stopped');
    const shardId = getShardForUser(userId, this.numShards);
    this.userShardMap.set(userId, shardId);
    await this.acquireShard(shardId);
    return shardId;
  }

  /**
   * Unregisters a user connection, decrementing the shard refCount
   * and starting the 30-second hysteresis drain timer when refCount hits 0.
   */
  unregisterUser(userId: string): number | null {
    const shardId = this.userShardMap.get(userId);
    if (shardId === undefined) return null;
    this.userShardMap.delete(userId);
    this.releaseShard(shardId);
    return shardId;
  }

  /**
   * Acquires a shard: increments refCount, cancels any active hysteresis drain timer,
   * and activates the consumer group and reader loop if inactive.
   */
  async acquireShard(shardId: number): Promise<void> {
    const state = this.shardStates.get(shardId);
    if (!state) return;

    // 1. If currently draining under hysteresis, cancel the drain timer immediately.
    if (state.drainTimer) {
      clearTimeout(state.drainTimer);
      state.drainTimer = null;
      state.status = 'active';
      logger.debug('[redis-stream-adapter] Shard drain cancelled via hysteresis reuse', {
        shardId,
        refCount: state.refCount + 1,
      });
    }

    state.refCount++;

    // 2. If already active, nothing more to do
    if (state.status === 'active') {
      return;
    }

    // 3. If currently activating, await the existing promise
    if (state.activationPromise) {
      return state.activationPromise;
    }

    // 4. Activate consumer group and reader loop
    state.status = 'activating';
    state.activationPromise = (async () => {
      try {
        await this.createGroupForShard(shardId);
        if (this.stopped) {
          state.status = 'inactive';
          return;
        }
        // F-01: Re-check refCount after async activation resolves.
        // If all subscribers disconnected while activation was in-flight,
        // transition directly to 'draining' and arm hysteresis timer.
        if (state.refCount === 0) {
          this.armDrainTimer(shardId, state);
          logger.info('[redis-stream-adapter] Shard activated with zero subscribers, entered draining', {
            shardId,
            group: this.groupName,
            hysteresisMs: this.hysteresisMs,
          });
        } else {
          state.status = 'active';
          logger.info('[redis-stream-adapter] Shard activated', {
            shardId,
            group: this.groupName,
            refCount: state.refCount,
          });
        }

        this.startShardReaderLoop(shardId);
      } catch (err) {
        state.status = 'inactive';
        logger.error('[redis-stream-adapter] Failed to activate shard', {
          shardId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        state.activationPromise = null;
      }
    })();

    return state.activationPromise;
  }

  /**
   * Helper to transition a shard to 'draining' and arm its hysteresis timer.
   */
  private armDrainTimer(shardId: number, state: InternalShardState): void {
    if (state.drainTimer) {
      clearTimeout(state.drainTimer);
      state.drainTimer = null;
    }
    state.status = 'draining';
    logger.debug('[redis-stream-adapter] Starting shard hysteresis timer', {
      shardId,
      hysteresisMs: this.hysteresisMs,
    });

    state.drainTimer = setTimeout(async () => {
      try {
        await this.deactivateShard(shardId);
      } catch (err) {
        logger.warn('[redis-stream-adapter] Error during shard deactivation', {
          shardId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.hysteresisMs);
  }

  /**
   * Decrements refCount for a shard. When refCount hits 0, starts the 30-second
   * hysteresis timer before destroying the consumer group.
   */
  releaseShard(shardId: number): void {
    const state = this.shardStates.get(shardId);
    if (!state) return;

    state.refCount = Math.max(0, state.refCount - 1);

    if (state.refCount === 0 && state.status === 'active') {
      this.armDrainTimer(shardId, state);
    }
  }

  /**
   * Deactivates a shard when hysteresis expires and refCount is still zero:
   * stops the reader loop and destroys the consumer group.
   */
  async deactivateShard(shardId: number): Promise<void> {
    const state = this.shardStates.get(shardId);
    if (!state || state.refCount > 0 || state.status !== 'draining') {
      return;
    }

    state.readerRunning = false;
    state.status = 'inactive';
    if (state.drainTimer) {
      clearTimeout(state.drainTimer);
      state.drainTimer = null;
    }

    const streamKey = getShardStreamKey(shardId, this.streamPrefix);
    try {
      const redis = this.getRedis();
      await redis.xgroup('DESTROY', streamKey, this.groupName);
      logger.info('[redis-stream-adapter] Shard consumer group destroyed', {
        shardId,
        streamKey,
        group: this.groupName,
      });
    } catch (err) {
      logger.debug('[redis-stream-adapter] XGROUP DESTROY skipped/error', {
        shardId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Ensures the consumer group exists on the given shard stream.
   * Uses '$' so only new events written after connection are consumed,
   * avoiding unbounded historic backfill into instance PEL.
   */
  private async createGroupForShard(shardId: number): Promise<void> {
    const streamKey = getShardStreamKey(shardId, this.streamPrefix);
    const redis = this.getRedis();
    try {
      // XGROUP CREATE <key> <group> $ MKSTREAM
      await redis.xgroup('CREATE', streamKey, this.groupName, '$', 'MKSTREAM');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('BUSYGROUP')) {
        // Group already exists, safe to ignore
        return;
      }
      throw err;
    }
  }

  /**
   * Runs an independent single-stream reader loop for a specific active shard.
   * Respects Redis Cluster single-slot constraints by reading exactly one stream key per call.
   */
  private startShardReaderLoop(shardId: number): void {
    const state = this.shardStates.get(shardId);
    if (!state || state.readerRunning) return;

    state.readerRunning = true;
    const streamKey = getShardStreamKey(shardId, this.streamPrefix);

    const loop = async () => {
      while (
        state.readerRunning &&
        (state.status === 'active' || state.status === 'draining') &&
        !this.stopped
      ) {
        try {
          const redis = this.getRedis();
          // XREADGROUP GROUP <group> <consumer> COUNT <count> BLOCK <ms> STREAMS <key> >
          const result = (await redis.xreadgroup(
            'GROUP',
            this.groupName,
            this.consumerName,
            'COUNT',
            this.batchSize,
            'BLOCK',
            this.blockMs,
            'STREAMS',
            streamKey,
            '>'
          )) as [string, [string, string[]][]][] | null;

          if (result && Array.isArray(result) && result.length > 0) {
            const streamEntries = result[0][1];
            for (const [msgId, fields] of streamEntries) {
              await this.handleStreamEntry(shardId, streamKey, msgId, fields);
            }
          } else {
            // If server returned null/empty (e.g. timeout on BLOCK or in-memory mock),
            // yield to event loop to avoid CPU spin.
            await new Promise((r) => setTimeout(r, 20));
          }
        } catch (err: unknown) {
          if (this.stopped || !state.readerRunning) break;
          const msg = err instanceof Error ? err.message : String(err);
          // NOGROUP occurs if group was externally deleted; recreate it
          if (msg.includes('NOGROUP')) {
            logger.warn('[redis-stream-adapter] Group missing, recreating', { shardId });
            try {
              await this.createGroupForShard(shardId);
            } catch {
              // ignore
            }
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      state.readerRunning = false;
    };

    void loop();
  }

  /**
   * Parses stream fields into ShardedStreamEvent, emits event, and ACKs message ID.
   */
  private async handleStreamEntry(
    shardId: number,
    streamKey: string,
    msgId: string,
    fields: string[]
  ): Promise<void> {
    const state = this.shardStates.get(shardId);
    if (state) state.messagesReceived++;

    const fieldsObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      fieldsObj[fields[i]] = fields[i + 1];
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(fieldsObj.payload || '{}');
    } catch {
      payload = {};
    }

    const event: ShardedStreamEvent = {
      id: msgId,
      origin: fieldsObj.origin || '',
      userId: fieldsObj.userId || '',
      type: (fieldsObj.type || 'runtime_state_patch') as any,
      sequence: parseInt(fieldsObj.sequence || '0', 10),
      timestamp: fieldsObj.timestamp || new Date().toISOString(),
      payload,
      correlationId: fieldsObj.correlationId,
      schemaVersion: fieldsObj.schemaVersion ? parseInt(fieldsObj.schemaVersion, 10) : 1,
    };

    // Emit event for local consumers
    this.totalEventsDelivered++;
    this.emit('message', event, msgId, shardId);

    // Immediately ACK to prevent PEL growth (INV-06)
    try {
      const redis = this.getRedis();
      await redis.xack(streamKey, this.groupName, msgId);
      if (state) state.messagesAcked++;
    } catch (ackErr) {
      logger.warn('[redis-stream-adapter] Failed to XACK message', {
        shardId,
        msgId,
        error: ackErr instanceof Error ? ackErr.message : String(ackErr),
      });
    }
  }

  /**
   * Publishes an event to the appropriate shard stream based on its userId.
   * Bounded via MAXLEN ~ maxLen.
   */
  async publishEvent(event: ShardedStreamEvent): Promise<string | null> {
    if (!isRedisConfigured() && !this.customRedisClient) {
      return null;
    }

    const shardId = getShardForUser(event.userId, this.numShards);
    const streamKey = getShardStreamKey(shardId, this.streamPrefix);
    const redis = this.customRedisClient ?? getRedisClient();

    try {
      const streamId = await redis.xadd(
        streamKey,
        'MAXLEN',
        '~',
        this.maxLen,
        '*',
        'origin',
        event.origin,
        'userId',
        event.userId,
        'type',
        event.type,
        'sequence',
        String(event.sequence || 0),
        'payload',
        JSON.stringify(event.payload || {}),
        'timestamp',
        event.timestamp || new Date().toISOString(),
        'correlationId',
        event.correlationId || '',
        'schemaVersion',
        String(event.schemaVersion || 1)
      );

      this.totalEventsPublished++;
      return typeof streamId === 'string' ? streamId : null;
    } catch (err) {
      logger.warn('[redis-stream-adapter] Failed to publish stream event', {
        shardId,
        userId: event.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Background garbage collector to prune orphaned consumer groups from crashed pods.
   * Invariant (INV-09): Only groups with idle time > 24 hours (86,400,000 ms) are destroyed.
   */
  async cleanupStaleConsumerGroups(maxIdleMs = 86_400_000): Promise<number> {
    if (!isRedisConfigured() && !this.customRedisClient) return 0;
    const redis = this.getRedis();
    let cleanedCount = 0;

    for (let s = 0; s < this.numShards; s++) {
      const streamKey = getShardStreamKey(s, this.streamPrefix);
      try {
        const groups = (await redis.xinfo('GROUPS', streamKey)) as any[];
        if (!Array.isArray(groups)) continue;

        for (const grp of groups) {
          // grp is array of key/value pairs or object depending on redis client
          let name = '';
          let idle = 0;

          if (Array.isArray(grp)) {
            for (let i = 0; i < grp.length; i += 2) {
              if (grp[i] === 'name') name = String(grp[i + 1]);
              if (grp[i] === 'lag-or-idle' || grp[i] === 'idle') idle = Number(grp[i + 1]);
            }
          } else if (typeof grp === 'object' && grp !== null) {
            name = grp.name;
            idle = grp.idle ?? 0;
          }

          if (
            name.startsWith('devtrack:sse:pod:') &&
            name !== this.groupName &&
            idle > maxIdleMs
          ) {
            await redis.xgroup('DESTROY', streamKey, name);
            cleanedCount++;
            logger.info('[redis-stream-adapter] Cleaned up stale consumer group', {
              streamKey,
              group: name,
              idleMs: idle,
            });
          }
        }
      } catch {
        // Stream may not exist yet or XINFO not supported on mock
      }
    }
    return cleanedCount;
  }

  /**
   * Diagnostic snapshot of all shard subscriptions and metrics.
   */
  getMetrics(): ShardedAdapterMetrics {
    const stats: ShardSubscriptionStats[] = [];
    let activeCount = 0;

    for (const [shardId, s] of this.shardStates) {
      if (s.status === 'active' || s.status === 'draining') {
        activeCount++;
      }
      stats.push({
        shardId,
        refCount: s.refCount,
        status: s.status,
        isDraining: s.status === 'draining',
        messagesReceived: s.messagesReceived,
        messagesAcked: s.messagesAcked,
      });
    }

    return {
      instanceId: this.instanceId,
      activeShards: activeCount,
      totalSubscribedUsers: this.userShardMap.size,
      totalEventsPublished: this.totalEventsPublished,
      totalEventsDelivered: this.totalEventsDelivered,
      shards: stats,
    };
  }

  isShardActive(shardId: number): boolean {
    const state = this.shardStates.get(shardId);
    return state ? state.status === 'active' : false;
  }

  isShardDraining(shardId: number): boolean {
    const state = this.shardStates.get(shardId);
    return state ? state.status === 'draining' : false;
  }

  hasConfiguredRedis(): boolean {
    return Boolean(this.customRedisClient || isRedisConfigured());
  }

  /**
   * Graceful shutdown: stops all loops, clears timers, and destroys all owned groups.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;

    // 1. Clear all hysteresis timers
    for (const state of this.shardStates.values()) {
      if (state.drainTimer) {
        clearTimeout(state.drainTimer);
        state.drainTimer = null;
      }
      state.readerRunning = false;
    }

    // 2. Destroy all consumer groups for active or draining shards
    const redis = this.customRedisClient ?? this.dedicatedRedisClient;
    if (redis) {
      const destroyPromises: Promise<any>[] = [];
      for (const [shardId, state] of this.shardStates) {
        if (state.status === 'active' || state.status === 'draining') {
          const streamKey = getShardStreamKey(shardId, this.streamPrefix);
          destroyPromises.push(
            redis.xgroup('DESTROY', streamKey, this.groupName).catch(() => undefined)
          );
        }
      }
      await Promise.allSettled(destroyPromises);
    }

    // 3. Disconnect dedicated connection
    if (this.dedicatedRedisClient) {
      try {
        await this.dedicatedRedisClient.disconnect();
      } catch {
        // ignore
      }
      this.dedicatedRedisClient = null;
    }

    this.removeAllListeners();
    logger.info('[redis-stream-adapter] Shutdown completed', { instanceId: this.instanceId });
  }
}
