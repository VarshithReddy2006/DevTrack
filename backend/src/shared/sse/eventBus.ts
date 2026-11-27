// src/shared/sse/eventBus.ts — In-memory event broadcaster with optional Redis pub/sub for horizontal scaling
// Local events for same-instance, Redis pub/sub for cross-instance event distribution.

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { logger } from '../logger.js';
import { captureTraceContext, runTraceOperation, type TraceCarrier } from '../tracing/propagation.js';
import { createRedisConnection, getRedisClient, getRedisHealth, isRedisConfigured } from '../redis/client.js';
import { RedisStreamAdapter } from './redisStreamAdapter.js';
import { TOTAL_SHARDS } from './shardRouter.js';
import type { ShardedStreamEvent, ShardedAdapterMetrics } from './redisStreamAdapter.types.js';

// ─── Zod validation schemas for SSE event payloads ─────────────────────────
const syncStartedPayload = z.object({
  platform: z.string(),
  syncId: z.string(),
  startedAt: z.string(),
});

const syncCompletedPayload = z.object({
  platform: z.string(),
  syncId: z.string(),
  duration: z.number(),
  stats: z.object({
    ingested: z.number(),
    updated: z.number(),
    skipped: z.number(),
  }),
  completedAt: z.string(),
});

const syncFailedPayload = z.object({
  platform: z.string(),
  syncId: z.string(),
  error: z.string(),
  retryable: z.boolean(),
  failedAt: z.string(),
});

const missionProgressPayload = z.object({
  missionId: z.string(),
  title: z.string(),
  currentCount: z.number(),
  targetCount: z.number(),
  completed: z.boolean(),
  progressPercent: z.number(),
});

const levelUpPayload = z.object({
  newLevel: z.number(),
  totalXp: z.number(),
  levelName: z.string(),
  levelTitle: z.string(),
});

const streakMilestonePayload = z.object({
  days: z.number(),
  xpBonus: z.number(),
  milestone: z.string(),
});

const streakAtRiskPayload = z.object({
  currentStreak: z.number(),
  hoursRemaining: z.number(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
});

const achievementUnlockedPayload = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  rarity: z.enum(['common', 'rare', 'epic', 'legendary']),
  xpReward: z.number(),
  unlockedAt: z.string(),
});

const behavioralMessagePayload = z.object({
  messageId: z.string(),
  tone: z.enum(['encouraging', 'calm', 'celebratory', 'gentle-nudge', 'supportive', 'silent']),
  text: z.string(),
  action: z.object({ label: z.string(), route: z.string() }).optional(),
  expiresAt: z.string().optional(),
});

const notificationCreatedPayload = z.object({
  notificationId: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  tone: z.string(),
  priority: z.string(),
});

const challengeCompletedPayload = z.object({
  challengeId: z.string(),
  title: z.string(),
  xpReward: z.number(),
  completedAt: z.string(),
});

const runtimeStatePatchPayload = z.record(z.unknown());
const runtimeStateFullPayload = z.object({ state: z.record(z.unknown()) });

const resumeProgressionPayload = z.object({
  sessionId: z.string(),
  stage: z.string(),
  progress: z.number(),
  message: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'degraded']),
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Mirrors the schemas the studio UI parses in useInterviewSession.ts.
const interviewTurnDeltaPayload = z.object({
  sessionId: z.string(),
  turnIndex: z.number().int().min(0),
  stateVersion: z.number().int().nonnegative(),
  delta: z.string(),
  seq: z.number().int().nonnegative(),
});

const interviewSessionCompletedPayload = z.object({
  sessionId: z.string(),
  mode: z.enum(['ai', 'basic_mode']).optional(),
});

const interviewTimeWarningPayload = z.object({
  sessionId: z.string().min(1), minutesRemaining: z.literal(5),
});

const interviewReportReadyPayload = z.object({
  sessionId: z.string().min(1), reportId: z.string().min(1),
  mode: z.enum(['ai', 'basic_mode']),
});

const webrtcSessionCreatedPayload = z.object({
  sessionId: z.string().min(1), userId: z.string().min(1),
  state: z.string().min(1), createdAt: z.string(),
});

const webrtcOfferAnsweredPayload = z.object({
  sessionId: z.string().min(1), userId: z.string().min(1),
  state: z.string().min(1), answeredAt: z.string(),
});

const webrtcConnectedPayload = z.object({
  sessionId: z.string().min(1), userId: z.string().min(1),
  state: z.string().min(1), connectedAt: z.string(),
});

const webrtcIceCandidatePayload = z.object({
  sessionId: z.string().min(1), userId: z.string().min(1),
  candidate: z.object({ candidate: z.string(), sdpMLineIndex: z.number(), sdpMid: z.string().optional(), usernameFragment: z.string().optional() }),
  serverCandidate: z.object({ candidate: z.string(), sdpMLineIndex: z.number(), sdpMid: z.string().optional(), usernameFragment: z.string().optional() }),
  state: z.string().min(1),
});

const webrtcIceTimeoutPayload = z.object({
  sessionId: z.string().min(1), userId: z.string().min(1),
  state: z.string().min(1), fallbackUrl: z.string().optional(), timedOutAt: z.string(),
});

const webrtcSessionClosedPayload = z.object({
  sessionId: z.string().min(1), userId: z.string().min(1),
  state: z.string().min(1), closedAt: z.string(),
});

function validateEventPayload(type: string, payload: unknown): Record<string, unknown> {
  let schema: z.ZodSchema<any>;
  switch (type) {
    case 'sync_started':
      schema = syncStartedPayload;
      break;
    case 'sync_completed':
      schema = syncCompletedPayload;
      break;
    case 'sync_failed':
      schema = syncFailedPayload;
      break;
    case 'mission_progress':
      schema = missionProgressPayload;
      break;
    case 'level_up':
      schema = levelUpPayload;
      break;
    case 'streak_milestone':
      schema = streakMilestonePayload;
      break;
    case 'streak_at_risk':
      schema = streakAtRiskPayload;
      break;
    case 'achievement_unlocked':
      schema = achievementUnlockedPayload;
      break;
    case 'behavioral_message':
      schema = behavioralMessagePayload;
      break;
    case 'notification_created':
      schema = notificationCreatedPayload;
      break;
    case 'challenge_completed':
      schema = challengeCompletedPayload;
      break;
    case 'runtime_state_patch':
      schema = runtimeStatePatchPayload;
      break;
    case 'runtime_state_full':
      schema = runtimeStateFullPayload;
      break;
    case 'resume_progression':
      schema = resumeProgressionPayload;
      break;
    case 'interview.turn.delta':
      schema = interviewTurnDeltaPayload;
      break;
    case 'interview.session.completed':
      schema = interviewSessionCompletedPayload;
      break;
    case 'interview.time_warning':
      schema = interviewTimeWarningPayload;
      break;
    case 'interview.report_ready':
      schema = interviewReportReadyPayload;
      break;
    case 'interview.webrtc.session.created':
      schema = webrtcSessionCreatedPayload;
      break;
    case 'interview.webrtc.offer.answered':
      schema = webrtcOfferAnsweredPayload;
      break;
    case 'interview.webrtc.connected':
      schema = webrtcConnectedPayload;
      break;
    case 'interview.webrtc.ice.candidate':
      schema = webrtcIceCandidatePayload;
      break;
    case 'interview.webrtc.ice.timeout':
      schema = webrtcIceTimeoutPayload;
      break;
    case 'interview.webrtc.session.closed':
      schema = webrtcSessionClosedPayload;
      break;
    default:
      return payload as Record<string, unknown>;
  }

  const result = schema.safeParse(payload);
  if (!result.success) {
    const errorDetails = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    logger.warn('[sse] Payload contract validation failed, proceeding with fallback parsing', {
      type,
      errorDetails,
      payload,
    });
  }
  return payload as Record<string, unknown>;
}

const SSE_CHANNEL = 'devtrack:sse:events';

// ---------------------------------------------------------------------------
// SSE Operational Metrics
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_SUBSCRIBER_QUEUE_EVENTS = 50;
export const DEFAULT_MAX_SUBSCRIBER_QUEUE_BYTES = 256 * 1024;
export const DEFAULT_STALL_TIMEOUT_MS = 10_000;

export interface EventBusOptions {
  maxSubscriberQueueEvents?: number;
  maxSubscriberQueueBytes?: number;
  stallTimeoutMs?: number;
}

export interface SseMetricsSnapshot {
  activeConnections: number;
  totalConnections: number;
  totalDisconnects: number;
  totalReconnects: number;
  heartbeatFailures: number;
  eventsPublished: number;
  uptimeSeconds: number;
  backpressureDrops: number;
  stalledDisconnects: number;
  bufferedEvents: number;
  bufferedBytes: number;
}

// ---------------------------------------------------------------------------
// Event types - Expanded taxonomy for unified runtime state
// ---------------------------------------------------------------------------

export type SseEventType =
  // Runtime state (primary)
  | 'runtime_state_patch'
  | 'runtime_state_full'
  // Behavioral
  | 'behavioral_message'
  | 'notification_created'
  // Progression moments
  | 'level_up'
  | 'streak_milestone'
  | 'streak_at_risk'
  | 'achievement_unlocked'
  | 'goal_completed'
  | 'challenge_completed'
  | 'near_milestone'
  | 'mission_progress'
  // Sync
  | 'sync_started'
  | 'sync_completed'
  | 'sync_failed'
  | 'new_submission'
  // Legacy (for backwards compatibility)
  | 'xp_updated'
  | 'badge_earned'
  // Resume progression
  | 'resume_progression'
  // v2 Milestone SSE events
  | 'focus_session_completed'
  | 'dsa_problem_solved'
  | 'contest_starting_soon'
  | 'contest.rating_updated'
  | 'revision_reviewed'
  | 'revision.card_created'
  | 'quest.completed'
  | 'quest.claimed'
  | 'streak_updated'
  | 'league_week_finalized'
  | 'league.rollover_completed'
  // AI mock interview studio
  | 'interview.turn.delta'
  | 'interview.session.completed'
  | 'interview.time_warning'
  | 'interview.report_ready'
  | 'interview.audio_transcribed'
  | 'interview.webrtc.session.created'
  | 'interview.webrtc.offer.answered'
  | 'interview.webrtc.connected'
  | 'interview.webrtc.ice.candidate'
  | 'interview.webrtc.ice.timeout'
  | 'interview.webrtc.session.closed'
  | 'jobtarget.updated'
  | 'evidence.verified'
  // Privacy & Compliance
  | 'privacy.export_ready'
  // System
  | 'heartbeat';

export interface SseEventEnvelope {
  id: string;
  type: SseEventType;
  sequence: number;
  timestamp: string;
  userId: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  schemaVersion?: number;
}

export interface SseEvent {
  id?: string;
  type: SseEventType;
  timestamp: string;
  userId?: string;
  platform?: string;
  payload?: any;
  stats?: {
    totalSolved?: number;
    easySolved?: number;
    mediumSolved?: number;
    hardSolved?: number;
    rating?: number;
    totalContests?: number;
    ingested?: number;
    successCount?: number;
    failedCount?: number;
    error?: string;
  };
}

// ---------------------------------------------------------------------------
// SseClient — one per SSE connection
// ---------------------------------------------------------------------------

export interface SseClient {
  id: string;
  userId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: number;
  emit(event: SseEvent): void;
  destroy(): void;
  /** Optional downstream socket backpressure signal. */
  isBackpressured?: () => boolean;
  /** Optional immediate response terminator used when evicting stalled subscribers. */
  terminate?: () => void;
}

interface ClientBufferState {
  queue: Uint8Array[];
  queuedBytes: number;
  stallTimer: NodeJS.Timeout | null;
  stalledSince: number | null;
}

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// EventBus — singleton broadcaster with operational metrics
// ---------------------------------------------------------------------------

class EventBus extends EventEmitter {
  private draining = false;
  private clients = new Map<string, SseClient>();
  private clientBuffers = new Map<string, ClientBufferState>();
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL_MS = 25_000;
  private readonly MAX_CLIENTS = 10_000;
  private readonly maxSubscriberQueueEvents: number;
  private readonly maxSubscriberQueueBytes: number;
  private readonly stallTimeoutMs: number;
  private redisSubscriber: ReturnType<typeof getRedisClient>['duplicate'] | null = null;
  private redisPublisher: ReturnType<typeof getRedisClient>['duplicate'] | null = null;

  // Operational metrics
  private totalConnections = 0;
  private totalDisconnects = 0;
  private totalReconnects = 0;
  private heartbeatFailures = 0;
  private eventsPublished = 0;
  private backpressureDrops = 0;
  private stalledDisconnects = 0;
  private readonly startedAt = Date.now();
  // Tags this instance's Redis messages so it can skip its own echo (already delivered locally).
  private readonly instanceId = randomUUID();

  // Event coalescing for runtime_state_patch
  // One buffer and one debounce timer per user, so a second user's patch never replaces the first's.
  private pendingPatches = new Map<string, { delta: Record<string, unknown>; timer: NodeJS.Timeout }>();
  private readonly PATCH_COALESCE_MS = 3000; // 3 seconds

  // Sharded Redis Stream Consumer Group Adapter for horizontal scaling
  readonly streamAdapter: RedisStreamAdapter;
  private readonly recentlyDeliveredIds = new Set<string>();

  constructor(customRedisClient?: any, options?: EventBusOptions) {
    super();
    this.setMaxListeners(this.MAX_CLIENTS);
    this.maxSubscriberQueueEvents =
      options?.maxSubscriberQueueEvents ?? DEFAULT_MAX_SUBSCRIBER_QUEUE_EVENTS;
    this.maxSubscriberQueueBytes =
      options?.maxSubscriberQueueBytes ?? DEFAULT_MAX_SUBSCRIBER_QUEUE_BYTES;
    this.stallTimeoutMs = options?.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.streamAdapter = new RedisStreamAdapter(
      this.instanceId,
      { numShards: TOTAL_SHARDS },
      customRedisClient
    );
    this.setupStreamAdapter();
    this.initRedisPubSub();
  }

  private setupStreamAdapter(): void {
    this.streamAdapter.on('message', (streamEvent: ShardedStreamEvent) => {
      // INV-08: Skip own echo (already delivered locally)
      if (streamEvent.origin === this.instanceId) return;

      if (streamEvent.id) {
        if (this.recentlyDeliveredIds.has(streamEvent.id)) return;
        this.trackDeliveredId(streamEvent.id);
      }

      const sseEvent: SseEvent = {
        id: streamEvent.id,
        type: streamEvent.type,
        timestamp: streamEvent.timestamp,
        userId: streamEvent.userId,
        payload: streamEvent.payload,
      };

      // INV-02: User isolation
      this.publishLocal(sseEvent, streamEvent.userId);
    });
  }

  private trackDeliveredId(id: string): void {
    this.recentlyDeliveredIds.add(id);
    if (this.recentlyDeliveredIds.size > 2000) {
      const first = this.recentlyDeliveredIds.values().next().value;
      if (first) this.recentlyDeliveredIds.delete(first);
    }
  }

  // ─── Redis pub/sub for horizontal scaling ─────────────────────────────────
  private async initRedisPubSub(): Promise<void> {
    if (!isRedisConfigured()) {
      logger.info('[sse] Neither REDIS_URL nor REDIS_HOST set — operating in local in-memory SSE mode (Redis Pub/Sub disabled)');
      return;
    }

    try {
      const connectionOptions: any = {
        lazyConnect: true,
        family: 0,
        retryStrategy(times: number) {
          const delay = Math.min(times * 100, 3000);
          logger.warn('[sse-redis] Reconnecting to Redis', { attempt: times, delayMs: delay });
          return delay;
        }
      };

      // Persistent subscriber
      const subscriber = createRedisConnection(connectionOptions) as any;
      this.redisSubscriber = subscriber;
      let isSubscribed = false;
      let subscriptionPromise: Promise<void> | null = null;

      const ensureSubscribed = async (): Promise<void> => {
        if (isSubscribed) return;
        if (subscriptionPromise) {
          return subscriptionPromise;
        }

        subscriptionPromise = (async () => {
          try {
            await (subscriber as any).subscribe(SSE_CHANNEL);
            isSubscribed = true;
            logger.info('[sse-redis] Subscribed to SSE channel', { channel: SSE_CHANNEL });
          } catch (err) {
            isSubscribed = false;
            logger.warn('[sse-redis] Failed to subscribe to SSE channel', {
              channel: SSE_CHANNEL,
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          } finally {
            subscriptionPromise = null;
          }
        })();

        return subscriptionPromise;
      };

      (subscriber as any).on('message', (_channel: string, message: string) => {
        try {
          const parsed = JSON.parse(message) as { origin?: string; event?: SseEvent } & SseEvent & TraceCarrier;
          const event = parsed.event ?? parsed;
          if (parsed.origin === this.instanceId) return;
          // Keep delivery synchronous for messages from peers that do not send trace context.
          if (!parsed.event || !parsed.traceparent) {
            this.publishLocal(event, event.userId);
            return;
          }
          void runTraceOperation('sse.receive', async () => {
            this.publishLocal(event, event.userId);
          }, parsed).catch(err => logger.warn('[sse] Redis delivery failed', { error: err }));
        } catch (err) {
          logger.warn('[sse] Failed to parse Redis message', { error: err });
        }
      });

      (subscriber as any).on('error', (err: Error) => {
        logger.error('[sse-redis] Subscriber error', err);
      });

      (subscriber as any).on('close', () => {
        // The channel subscription is lost with the connection; subscribe again on the next 'ready'
        isSubscribed = false;
      });

      (subscriber as any).on('ready', () => {
        logger.info('[sse-redis] Subscriber connection ready');
        // Handle late connect or reconnect if initial setup subscribe was not established
        void ensureSubscribed().catch(() => {
          // Warning logged with context inside ensureSubscribed
        });
      });

      await (subscriber as any).connect().catch((err: unknown) => {
        logger.warn('[sse-redis] Subscriber connect failed', { error: err instanceof Error ? err.message : String(err) });
      });

      if ((subscriber as any).status === 'ready' && !isSubscribed) {
        await ensureSubscribed().catch(() => {
          // Warning logged with context inside ensureSubscribed
        });
      }
      if (this.draining) return;

      // Shared singleton publisher
      const publisher = createRedisConnection(connectionOptions) as any;
      this.redisPublisher = publisher;
      (publisher as any).on('error', (err: Error) => {
        logger.error('[sse-redis] Publisher error', err);
      });
      (publisher as any).on('ready', () => {
        logger.info('[sse-redis] Publisher connection ready');
      });
      await (publisher as any).connect().catch((err: unknown) => {
        logger.warn('[sse-redis] Publisher connect failed', { error: err instanceof Error ? err.message : String(err) });
      });
      if (this.draining) return;

      logger.info('[sse] Redis PubSub & Publisher singletons initialized', { channel: SSE_CHANNEL });
    } catch (err) {
      logger.warn('[sse] Redis PubSub initialization failed, using local fallback', { error: err });
    }
  }

  hasRedisPubSub(): boolean {
    return Boolean(
      (this.redisSubscriber as any)?.status === 'ready' &&
      (this.redisPublisher as any)?.status === 'ready'
    );
  }

  private async publishToRedis(event: SseEvent): Promise<void> {
    if (!this.streamAdapter.hasConfiguredRedis()) return;
    await runTraceOperation('sse.publish', async () => {
      // 1. Publish to sharded Redis Streams for horizontal scaling
      await this.streamAdapter.publishEvent({
        origin: this.instanceId,
        userId: event.userId || 'system',
        type: event.type,
        sequence: 0,
        timestamp: event.timestamp || new Date().toISOString(),
        payload: event.payload || {},
      });
      const payload = JSON.stringify({ origin: this.instanceId, event, ...captureTraceContext() });
      if (this.redisPublisher && (this.redisPublisher as any).status === 'ready') {
        await (this.redisPublisher as any).publish(SSE_CHANNEL, payload);
      } else if (getRedisHealth().status === 'connected') {
        // Fall back to the shared client while the dedicated publisher is reconnecting
        await getRedisClient().publish(SSE_CHANNEL, payload);
      }
    }).catch(err => logger.debug('[sse] Redis publish failed', { error: err }));
  }

  private isClientBackpressured(client: SseClient): boolean {
    if (client.isBackpressured?.()) return true;
    const desired = client.controller?.desiredSize;
    return typeof desired === 'number' && desired <= 0;
  }

  private getOrCreateBuffer(clientId: string): ClientBufferState {
    let buf = this.clientBuffers.get(clientId);
    if (!buf) {
      buf = { queue: [], queuedBytes: 0, stallTimer: null, stalledSince: null };
      this.clientBuffers.set(clientId, buf);
    }
    return buf;
  }

  private clearClientBuffer(clientId: string): void {
    const buf = this.clientBuffers.get(clientId);
    if (!buf) return;
    if (buf.stallTimer) {
      clearTimeout(buf.stallTimer);
      buf.stallTimer = null;
    }
    buf.queue.length = 0;
    buf.queuedBytes = 0;
    buf.stalledSince = null;
    this.clientBuffers.delete(clientId);
  }

  private evictStalledClient(client: SseClient, reason: 'buffer_overflow' | 'stall_timeout'): void {
    this.stalledDisconnects++;
    const buf = this.clientBuffers.get(client.id);
    logger.warn('[sse] Forcefully disconnecting stalled SSE subscriber', {
      event: reason === 'buffer_overflow' ? 'sse_subscriber_buffer_overflow' : 'sse_subscriber_stall_timeout',
      clientId: client.id,
      userId: client.userId,
      queuedEvents: buf?.queue.length ?? 0,
      queuedBytes: buf?.queuedBytes ?? 0,
      maxEvents: this.maxSubscriberQueueEvents,
      maxBytes: this.maxSubscriberQueueBytes,
      stallTimeoutMs: this.stallTimeoutMs,
    });

    try {
      client.terminate?.();
    } catch {
      // ignore termination errors
    }
    try {
      if (typeof client.controller?.close === 'function') {
        client.controller.close();
      }
    } catch {
      // ignore if stream already closed
    }
    this.unregister(client.id);
  }

  private dispatchToClient(client: SseClient, encoded: Uint8Array, isHeartbeat = false): boolean {
    if (!this.clients.has(client.id)) return false;
    const buf = this.getOrCreateBuffer(client.id);

    if (buf.queue.length === 0 && !this.isClientBackpressured(client)) {
      try {
        client.controller.enqueue(encoded);
        return true;
      } catch {
        this.unregister(client.id);
        return false;
      }
    }

    // Do not pile redundant heartbeats into a backpressured client's buffer.
    if (isHeartbeat) {
      if (buf.stallTimer === null) {
        buf.stalledSince = Date.now();
        buf.stallTimer = setTimeout(() => {
          const stalledClient = this.clients.get(client.id);
          if (stalledClient && (this.isClientBackpressured(stalledClient) || (this.clientBuffers.get(client.id)?.queue.length ?? 0) > 0)) {
            this.evictStalledClient(stalledClient, 'stall_timeout');
          }
        }, this.stallTimeoutMs);
        buf.stallTimer.unref?.();
      }
      return true;
    }

    const nextCount = buf.queue.length + 1;
    const nextBytes = buf.queuedBytes + encoded.byteLength;
    if (nextCount > this.maxSubscriberQueueEvents || nextBytes > this.maxSubscriberQueueBytes) {
      this.backpressureDrops++;
      this.evictStalledClient(client, 'buffer_overflow');
      return false;
    }

    buf.queue.push(encoded);
    buf.queuedBytes = nextBytes;

    if (buf.stallTimer === null) {
      buf.stalledSince = Date.now();
      buf.stallTimer = setTimeout(() => {
        const stalledClient = this.clients.get(client.id);
        if (stalledClient && ((this.clientBuffers.get(client.id)?.queue.length ?? 0) > 0 || this.isClientBackpressured(stalledClient))) {
          this.evictStalledClient(stalledClient, 'stall_timeout');
        }
      }, this.stallTimeoutMs);
      buf.stallTimer.unref?.();
    }

    return true;
  }

  /**
   * Flushes buffered chunks to a subscriber once downstream socket/stream backpressure clears.
   */
  notifyClientDrain(clientId: string): void {
    const client = this.clients.get(clientId);
    const buf = this.clientBuffers.get(clientId);
    if (!client || !buf) return;

    while (buf.queue.length > 0 && !this.isClientBackpressured(client)) {
      const next = buf.queue.shift()!;
      buf.queuedBytes = Math.max(0, buf.queuedBytes - next.byteLength);
      try {
        client.controller.enqueue(next);
      } catch {
        this.unregister(client.id);
        return;
      }
    }

    if (buf.queue.length === 0 && !this.isClientBackpressured(client)) {
      if (buf.stallTimer) {
        clearTimeout(buf.stallTimer);
        buf.stallTimer = null;
      }
      buf.stalledSince = null;
    }
  }

  private publishLocal(event: SseEvent, targetUserId?: string): void {
    let payload = '';
    if (event.id) {
      payload += `id: ${event.id}\n`;
    }
    payload += `data: ${JSON.stringify(event)}\n\n`;
    const encoded = encoder.encode(payload);

    const targets = targetUserId
      ? [...this.clients.values()].filter((c) => c.userId === targetUserId)
      : [...this.clients.values()];

    for (const client of targets) {
      this.dispatchToClient(client, encoded);
    }
  }

  // ---------------------------------------------------------------------------
  // Client management
  // ---------------------------------------------------------------------------

  register(client: SseClient): void {
    if (this.draining) throw new Error('Server is shutting down');
    if (this.clients.size >= this.MAX_CLIENTS) {
      logger.warn('[sse] Max clients reached, rejecting connection', {
        currentClients: this.clients.size,
        maxClients: this.MAX_CLIENTS,
        event: 'sse_max_clients_reached',
      });
      throw new Error('Server at capacity');
    }

    const isFirstClientForUser = !Array.from(this.clients.values()).some(
      (c) => c.userId === client.userId
    );

    this.clients.set(client.id, client);
    this.getOrCreateBuffer(client.id);
    this.totalConnections++;

    // Shard routing & activation (only register shard on first connection for user on this pod)
    if (isFirstClientForUser) {
      void this.streamAdapter.registerUser(client.userId).catch((err) => {
        logger.warn('[sse] Stream adapter shard activation error', {
          userId: client.userId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    logger.info('[sse] Client connected', {
      event: 'sse_client_connected',
      clientId: client.id,
      userId: client.userId,
      activeConnections: this.clients.size,
      totalConnections: this.totalConnections,
    });
  }

  unregister(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const lifetime = Date.now() - client.connectedAt;
    const userId = client.userId;
    this.clearClientBuffer(clientId);
    this.clients.delete(clientId);
    this.totalDisconnects++;
    client.destroy();

    // If no remaining clients on this pod for this user, release shard
    const hasMoreForUser = Array.from(this.clients.values()).some((c) => c.userId === userId);
    if (!hasMoreForUser) {
      this.streamAdapter.unregisterUser(userId);
    }

    logger.info('[sse] Client disconnected', {
      event: 'sse_client_disconnected',
      clientId,
      userId: client.userId,
      activeConnections: this.clients.size,
      totalDisconnects: this.totalDisconnects,
      lifetimeMs: lifetime,
    });
  }

  // ---------------------------------------------------------------------------
  // Event emission — userId-scoped (user only sees their own events)
  // ---------------------------------------------------------------------------

  publish(event: SseEvent, targetUserId?: string): void {
    this.eventsPublished++;

    // Local delivery (same instance)
    this.publishLocal(event, targetUserId);

    // Cross-instance delivery via Redis pub/sub
    void this.publishToRedis(event);

    logger.debug('[sse] Event published', {
      event: 'sse_event_published',
      type: event.type,
      userId: event.userId ?? 'system',
      targetUserId: targetUserId ?? 'broadcast',
      clientCount: this.clients.size,
      totalEvents: this.eventsPublished,
    });
  }

  // ---------------------------------------------------------------------------
  // Heartbeat — keeps connections alive, detects stale clients
  // ---------------------------------------------------------------------------

  startHeartbeat(): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      // A named event, not a `: comment` line: browsers never hand SSE comments to the page, so
      // the client could not tell an idle healthy stream from a dead one.
      const payload = encoder.encode(`event: heartbeat\ndata: {}\n\n`);
      let failed = 0;

      for (const client of [...this.clients.values()]) {
        if (!this.dispatchToClient(client, payload, true)) {
          failed++;
        }
      }

      if (failed > 0) {
        this.heartbeatFailures += failed;
        logger.warn('[sse] Heartbeat failed for clients, cleaned up', {
          event: 'sse_heartbeat_failure',
          failed,
          remainingClients: this.clients.size,
          heartbeatFailures: this.heartbeatFailures,
        });
      }
    }, this.HEARTBEAT_INTERVAL_MS);

    logger.info('[sse] Heartbeat started', {
      event: 'sse_heartbeat_started',
      intervalMs: this.HEARTBEAT_INTERVAL_MS,
    });
  }

  stopHeartbeat(): void {
    if (!this.heartbeatInterval) return;
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = null;
    logger.info('[sse] Heartbeat stopped', { event: 'sse_heartbeat_stopped' });
  }

  // ---------------------------------------------------------------------------
  // Metrics & diagnostics
  // ---------------------------------------------------------------------------

  recordReconnect(): void {
    this.totalReconnects++;
  }

  getMetrics(): SseMetricsSnapshot {
    let bufferedEvents = 0;
    let bufferedBytes = 0;
    for (const buf of this.clientBuffers.values()) {
      bufferedEvents += buf.queue.length;
      bufferedBytes += buf.queuedBytes;
    }
    return {
      activeConnections: this.clients.size,
      totalConnections: this.totalConnections,
      totalDisconnects: this.totalDisconnects,
      totalReconnects: this.totalReconnects,
      heartbeatFailures: this.heartbeatFailures,
      eventsPublished: this.eventsPublished,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      backpressureDrops: this.backpressureDrops,
      stalledDisconnects: this.stalledDisconnects,
      bufferedEvents,
      bufferedBytes,
    };
  }

  // ---------------------------------------------------------------------------
  // Broadcast helpers (convenience wrappers)
  // ---------------------------------------------------------------------------

  emitSyncStarted(userId: string, platform?: string, syncJobId?: string): void {
    const defaultPlatform = platform || 'leetcode';
    const syncId = syncJobId || `sync_${defaultPlatform}_${Date.now()}`;
    this.publish(
      {
        type: 'sync_started',
        timestamp: new Date().toISOString(),
        userId,
        platform: defaultPlatform,
        payload: {
          platform: defaultPlatform,
          syncId,
          startedAt: new Date().toISOString(),
        },
        stats: { totalSolved: 0 },
      },
      userId
    );
  }

  emitSyncCompleted(userId: string, platform: string, stats?: SseEvent['stats'], durationMs?: number, syncJobId?: string): void {
    const syncId = syncJobId || `sync_${platform}_${Date.now()}`;
    this.publish(
      {
        type: 'sync_completed',
        timestamp: new Date().toISOString(),
        userId,
        platform,
        stats,
        payload: {
          platform,
          syncId,
          duration: durationMs ?? 0,
          stats: {
            ingested: stats?.ingested ?? 0,
            updated: stats?.successCount ?? 0,
            skipped: stats?.failedCount ?? 0,
          },
          completedAt: new Date().toISOString(),
        },
      },
      userId
    );
  }

  emitSyncFailed(userId: string, platform: string, error: string, syncJobId?: string): void {
    const syncId = syncJobId || `sync_${platform}_${Date.now()}`;
    this.publish(
      {
        type: 'sync_failed',
        timestamp: new Date().toISOString(),
        userId,
        platform,
        stats: { error },
        payload: {
          platform,
          syncId,
          error,
          retryable: true,
          failedAt: new Date().toISOString(),
        },
      },
      userId
    );
  }

  emitNewSubmission(userId: string, platform: string, ingested: number): void {
    this.publish(
      {
        type: 'new_submission',
        timestamp: new Date().toISOString(),
        userId,
        platform,
        stats: { ingested },
        payload: {
          platform,
          problemId: 'accepted',
          problemTitle: 'New DSA Activity',
          status: 'accepted',
          language: 'javascript',
          submittedAt: new Date().toISOString(),
        },
      },
      userId
    );
  }

  emitXpUpdated(userId: string, totalXp: number, gainedXp: number, currentLevel: number, nextLevelXp: number): void {
    this.publish(
      {
        type: 'xp_updated',
        timestamp: new Date().toISOString(),
        userId,
        payload: {
          xpAwarded: gainedXp,
          newTotalXp: totalXp,
          source: 'manual',
          reason: 'Activity completed',
        },
        stats: {
          totalSolved: totalXp,
          easySolved: gainedXp,
          mediumSolved: currentLevel,
          hardSolved: nextLevelXp,
        },
      },
      userId
    );
  }

  emitLevelUp(userId: string, newLevel: number, totalXp: number): void {
    this.publish(
      {
        type: 'level_up',
        timestamp: new Date().toISOString(),
        userId,
        payload: {
          newLevel,
          totalXp,
          levelName: `Level ${newLevel}`,
          levelTitle: `Level ${newLevel}`,
        },
        stats: {
          totalSolved: totalXp,
          rating: newLevel,
        },
      },
      userId
    );
  }

  emitStreakMilestone(userId: string, streakDays: number, streakType: string): void {
    this.publish(
      {
        type: 'streak_milestone',
        timestamp: new Date().toISOString(),
        userId,
        payload: {
          days: streakDays,
          xpBonus: 100,
          milestone: streakDays >= 30 ? 'monthly' : streakDays >= 14 ? 'biweekly' : 'weekly',
        },
        stats: {
          totalSolved: streakDays,
          easySolved: streakType === 'dsa' ? 1 : 0,
          mediumSolved: streakType === 'github' ? 1 : 0,
          hardSolved: streakType === 'unified' ? 1 : 0,
        },
      },
      userId
    );
  }

  emitStreakAtRisk(userId: string, currentStreak: number, hoursRemaining: number): void {
    const riskLevel =
      hoursRemaining <= 4 ? 'critical' :
      hoursRemaining <= 7 ? 'high' :
      hoursRemaining <= 12 ? 'medium' : 'low';

    void this.publishEnvelope(userId, 'streak_at_risk', {
      currentStreak,
      hoursRemaining,
      riskLevel,
    });
  }

  emitAchievementUnlocked(
    userId: string,
    achievement: {
      id: string;
      name: string;
      description: string;
      icon: string;
      rarity: 'common' | 'rare' | 'epic' | 'legendary';
      xpReward: number;
    }
  ): void {
    const payload = {
      id: achievement.id,
      name: achievement.name,
      description: achievement.description,
      icon: achievement.icon,
      rarity: achievement.rarity,
      xpReward: achievement.xpReward,
      unlockedAt: new Date().toISOString(),
    };
    this.publish(
      {
        type: 'achievement_unlocked',
        timestamp: new Date().toISOString(),
        userId,
        payload,
        stats: payload as any,
      },
      userId
    );
  }

  emitBadgeEarned(userId: string, badgeId: string, badgeName: string): void {
    this.emitAchievementUnlocked(userId, {
      id: badgeId,
      name: badgeName,
      description: 'You unlocked an achievement!',
      icon: '🏆',
      rarity: 'common',
      xpReward: 0,
    });
  }

  async emitChallengeCompleted(
    userId: string,
    challengeId: string,
    title: string,
    xpReward: number
  ): Promise<void> {
    await this.publishEnvelope(userId, 'challenge_completed', {
      challengeId,
      title,
      xpReward,
      completedAt: new Date().toISOString(),
    });
  }

  // ─── New SSE event emitters for unified runtime state ─────────────────────

  async emitRuntimeStatePatch(userId: string, delta: Record<string, unknown>): Promise<void> {
    // Coalesce patches - max 1 per 3 seconds
    const pending = this.pendingPatches.get(userId);
    if (pending) {
      // Merge with this user's pending patch
      pending.delta = { ...pending.delta, ...delta };
      return;
    }

    const timer = setTimeout(async () => {
      const entry = this.pendingPatches.get(userId);
      this.pendingPatches.delete(userId);
      if (!entry) return;
      try {
        await this.publishEnvelope(userId, 'runtime_state_patch', entry.delta);
      } catch (error) {
        logger.warn('[sse] Failed to flush coalesced runtime_state_patch', { userId, error });
      }
    }, this.PATCH_COALESCE_MS);
    this.pendingPatches.set(userId, { delta, timer });
  }

  async emitRuntimeStateFull(userId: string, state: Record<string, unknown>): Promise<void> {
    // Bypass coalescing for full state (e.g., on reconnect)
    await this.publishEnvelope(userId, 'runtime_state_full', { state });
  }

  async emitBehavioralMessage(
    userId: string,
    messageId: string,
    tone: 'encouraging' | 'calm' | 'celebratory' | 'gentle-nudge' | 'supportive' | 'silent',
    text: string,
    action?: { label: string; route: string },
    expiresAt?: Date
  ): Promise<void> {
    await this.publishEnvelope(userId, 'behavioral_message', {
      messageId,
      tone,
      text,
      action,
      expiresAt: expiresAt?.toISOString(),
    });
  }

  async emitNotificationCreated(
    userId: string,
    notificationId: string,
    type: string,
    title: string,
    body: string,
    tone: string,
    priority: string
  ): Promise<void> {
    await this.publishEnvelope(userId, 'notification_created', {
      notificationId,
      type,
      title,
      body,
      tone,
      priority,
    });
  }

  async emitMissionProgress(
    userId: string,
    missionData: {
      missionId: string;
      title: string;
      currentCount: number;
      targetCount: number;
      completed: boolean;
    }
  ): Promise<void> {
    await this.publishEnvelope(userId, 'mission_progress', {
      missionId: missionData.missionId,
      title: missionData.title,
      currentCount: missionData.currentCount,
      targetCount: missionData.targetCount,
      completed: missionData.completed,
      progressPercent: Math.round((missionData.currentCount / missionData.targetCount) * 100),
    });
  }

  // ─── AI mock interview events ─────────────────────────────────────────────

  /**
   * One streamed piece of the interviewer's reply. Sent straight to the user's open
   * connections without an SSE id and without the Redis replay stream: a reply can be
   * hundreds of tokens, which would push every other event out of the 100-entry backfill
   * window and move the client's Last-Event-ID onto ids that are not replayable. A client
   * that misses deltas orders and de-duplicates them by `seq` and reads the final reply
   * from the session snapshot.
   */
  emitInterviewTurnDelta(
    userId: string,
    payload: { sessionId: string; turnIndex: number; stateVersion: number; delta: string; seq: number },
  ): void {
    this.publish(
      {
        type: 'interview.turn.delta',
        timestamp: new Date().toISOString(),
        userId,
        payload: validateEventPayload('interview.turn.delta', payload),
      },
      userId,
    );
  }

  /** The final scorecard is stored; sent as a normal envelope so a reconnecting client replays it. */
  async emitInterviewSessionCompleted(
    userId: string,
    payload: { sessionId: string; mode?: 'ai' | 'basic_mode' },
  ): Promise<void> {
    await this.publishEnvelope(userId, 'interview.session.completed', payload);
  }

  // ─── AI mock interview WebRTC signaling events ───────────────────────────

  async emitWebrtcSessionCreated(
    userId: string,
    payload: { sessionId: string; state: string; createdAt: string },
  ): Promise<void> {
    await this.publishEnvelope(userId, 'interview.webrtc.session.created', payload);
  }

  async emitWebrtcOfferAnswered(
    userId: string,
    payload: { sessionId: string; state: string; answeredAt: string },
  ): Promise<void> {
    await this.publishEnvelope(userId, 'interview.webrtc.offer.answered', payload);
  }

  async emitWebrtcConnected(
    userId: string,
    payload: { sessionId: string; state: string; connectedAt: string },
  ): Promise<void> {
    await this.publishEnvelope(userId, 'interview.webrtc.connected', payload);
  }

  async emitWebrtcIceCandidate(
    userId: string,
    payload: { sessionId: string; candidate: unknown; serverCandidate: unknown; state: string },
  ): Promise<void> {
    await this.publishEnvelope(userId, 'interview.webrtc.ice.candidate', payload);
  }

  async emitWebrtcIceTimeout(
    userId: string,
    payload: { sessionId: string; state: string; fallbackUrl?: string; timedOutAt: string },
  ): Promise<void> {
    await this.publishEnvelope(userId, 'interview.webrtc.ice.timeout', payload);
  }

  async emitWebrtcSessionClosed(
    userId: string,
    payload: { sessionId: string; state: string; closedAt: string },
  ): Promise<void> {
    await this.publishEnvelope(userId, 'interview.webrtc.session.closed', payload);
  }

  // ─── Helper to publish envelope with sequence number ─────────────────────

  async publishEnvelope(
    userId: string,
    type: SseEventType,
    payload: Record<string, unknown>,
    correlationId?: string,
    schemaVersion?: number
  ): Promise<void> {
    const validatedPayload = validateEventPayload(type, payload);
    
    // Fallback directly to in-memory publishing when Redis is disconnected
    if (getRedisHealth().status !== 'connected') {
      const fallbackSeq = Math.floor(Date.now() / 1000);
      const eventId = `${userId}-fallback-${fallbackSeq}-${Date.now()}`;
      
      logger.debug('[sse] Redis disconnected — executing fallback direct in-memory publish', {
        type,
        userId,
        eventId,
      });

      this.publish(
        {
          id: eventId,
          type,
          timestamp: new Date().toISOString(),
          userId,
          stats: validatedPayload as SseEvent['stats'],
          payload: validatedPayload,
        },
        userId
      );
      return;
    }
    
    const redis = getRedisClient();
    
    // Get next sequence number for this user
    const sequenceKey = `sse:seq:${userId}`;
    const sequence = await redis.incr(sequenceKey);
    // Keep sequence key alive as long as the stream — prevents unbounded key accumulation
    await redis.expire(sequenceKey, 300);
    
    const timestamp = new Date().toISOString();
    const fallbackId = `${userId}-${sequence}-${Date.now()}`;

    // Log to Redis stream for backfill (5 min retention, max 100 entries)
    const streamKey = `sse:stream:${userId}`;
    const streamId = await redis.xadd(
      streamKey,
      '*',
      'type',
      type,
      'sequence',
      sequence.toString(),
      'payload',
      JSON.stringify(validatedPayload),
      'timestamp',
      timestamp,
      'correlationId',
      correlationId || fallbackId,
      'schemaVersion',
      (schemaVersion || 1).toString()
    );

    // Live events carry the Redis Stream ID, the same id a replay emits, so a client's
    // Last-Event-ID always names a real position in the stream.
    const eventId = typeof streamId === 'string' && streamId ? streamId : fallbackId;

    const envelope: SseEventEnvelope = {
      id: eventId,
      type,
      sequence,
      timestamp,
      userId,
      payload: validatedPayload,
      correlationId: correlationId || eventId,
      schemaVersion: schemaVersion || 1,
    };
    await redis.expire(streamKey, 300); // 5 minutes
    await redis.xtrim(streamKey, 'MAXLEN', '~', 100);

    // Also publish to horizontal sharded streams
    void this.streamAdapter.publishEvent({
      origin: this.instanceId,
      userId,
      type,
      sequence,
      timestamp,
      payload: validatedPayload,
      correlationId: correlationId || eventId,
      schemaVersion: schemaVersion || 1,
    });
    
    // Publish as legacy event for backward compatibility
    this.publish(
      {
        id: eventId,
        type,
        timestamp: envelope.timestamp,
        userId,
        stats: validatedPayload as SseEvent['stats'],
        payload: validatedPayload, // Include payload for full compatibility
      },
      userId
    );
  }

  // ─── Legacy emit methods (for backward compatibility) ─────────────────────

  emitRuntimeStateUpdated(userId: string, state: Record<string, unknown>): void {
    // Use new patch method
    void this.emitRuntimeStatePatch(userId, state);
  }

  broadcastShutdown(): void {
    this.draining = true;
    for (const client of this.clients.values()) {
      const reconnectDelayMs = 2000 + Math.floor(Math.random() * 3001);
      const data = JSON.stringify({ reconnectDelayMs });
      try {
        client.controller.enqueue(encoder.encode(`event: server_shutdown\nretry: ${reconnectDelayMs}\ndata: ${data}\n\n`));
        client.controller.close();
      } catch {
        // The response may already have disconnected.
      }
      this.unregister(client.id);
    }
  }

  async shutdown(): Promise<void> {
    this.stopHeartbeat();
    for (const { timer } of this.pendingPatches.values()) {
      clearTimeout(timer);
    }
    this.pendingPatches.clear();
    for (const client of [...this.clients.values()]) {
      try {
        client.controller.close();
      } catch {
        // ignore
      }
      this.clearClientBuffer(client.id);
      client.destroy();
    }
    this.clients.clear();
    this.clientBuffers.clear();

    await this.streamAdapter.shutdown();

    if (this.redisSubscriber) {
      try {
        (this.redisSubscriber as any).disconnect();
      } catch {
        // ignore
      }
      this.redisSubscriber = null;
    }
    if (this.redisPublisher) {
      try {
        (this.redisPublisher as any).disconnect();
      } catch {
        // ignore
      }
      this.redisPublisher = null;
    }
    logger.info('[sse] EventBus shutdown', { event: 'sse_shutdown' });
  }
}
// Module-level singleton & class export
export { EventBus };
export const eventBus = new EventBus();
export default eventBus;
