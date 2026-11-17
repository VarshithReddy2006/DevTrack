// src/shared/events/outboxRelay.ts — read side of the Transactional Outbox.
// Claims committed events with a lease, hands one job per subscribed consumer
// queue to BullMQ (jobId = eventId, so a republish is a no-op), then marks them
// published. A crashed relay leaves a `processing` row whose lease runs out, and
// the next claim picks it up again.
import { OutboxEvent, type IOutboxEvent } from '../../db/models/outboxEvent.model.js';
import type { DomainEventEnvelope } from './eventContract.js';

export const OUTBOX_LEASE_MS = 30_000;
export const OUTBOX_MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;

export interface OutboxRelayOptions {
  /** Queue names that should receive an event of this type. */
  resolveQueues: (eventType: string) => string[];
  /** Adds one job. Must be idempotent per (queue, jobId), which BullMQ is. */
  enqueue: (queue: string, jobId: string, envelope: DomainEventEnvelope) => Promise<void>;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  onError?: (err: unknown, event?: IOutboxEvent) => void;
}

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

export function toEnvelope(e: IOutboxEvent): DomainEventEnvelope {
  return {
    id: e.eventId,
    type: e.type,
    schemaVersion: e.schemaVersion,
    correlationId: e.traceContext?.correlationId ?? e.eventId,
    causationId: e.traceContext?.causationId ?? e.eventId,
    userId: e.userId,
    timestamp: e.createdAt.toISOString(),
    payload: e.payload,
    metadata: { aggregateType: e.aggregateType, aggregateId: e.aggregateId },
  };
}

export class OutboxRelay {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  constructor(private readonly opts: OutboxRelayOptions) {
    this.batchSize = opts.batchSize ?? 25;
    this.leaseMs = opts.leaseMs ?? OUTBOX_LEASE_MS;
    this.maxAttempts = opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Atomically claims up to `batchSize` events, oldest first. Each claim is a
   * single findOneAndUpdate, so two relays can never hold the same row.
   * Claimable: pending and due, or processing with an expired lease.
   */
  async claimBatch(): Promise<IOutboxEvent[]> {
    const claimed: IOutboxEvent[] = [];
    for (let i = 0; i < this.batchSize; i++) {
      const now = this.now();
      const doc = await OutboxEvent.findOneAndUpdate(
        {
          $or: [
            { status: 'pending', nextAttemptAt: { $lte: now } },
            { status: 'processing', leaseExpiresAt: { $lt: now } },
          ],
        },
        { $set: { status: 'processing', leaseExpiresAt: new Date(now.getTime() + this.leaseMs) } },
        { sort: { createdAt: 1 }, new: true },
      );
      if (!doc) break;
      claimed.push(doc);
    }
    return claimed;
  }

  /** Publishes one claimed event; returns the status it ended in. */
  async publish(event: IOutboxEvent): Promise<'published' | 'pending' | 'dead'> {
    try {
      const envelope = toEnvelope(event);
      const queues = this.opts.resolveQueues(event.type);
      for (const queue of queues) await this.opts.enqueue(queue, event.eventId, envelope);
      await OutboxEvent.updateOne(
        { _id: event._id, status: 'processing' },
        { $set: { status: 'published', publishedAt: this.now(), leaseExpiresAt: null, lastError: null } },
      );
      return 'published';
    } catch (err) {
      this.opts.onError?.(err, event);
      const attempts = event.attempts + 1;
      const dead = attempts >= this.maxAttempts;
      await OutboxEvent.updateOne(
        { _id: event._id, status: 'processing' },
        {
          $set: {
            status: dead ? 'dead' : 'pending',
            attempts,
            leaseExpiresAt: null,
            nextAttemptAt: new Date(this.now().getTime() + backoffMs(attempts)),
            lastError: err instanceof Error ? err.message : String(err),
          },
        },
      );
      return dead ? 'dead' : 'pending';
    }
  }

  /** One claim-and-publish pass. Returns how many events were handled. */
  async tick(): Promise<number> {
    const batch = await this.claimBatch();
    for (const event of batch) await this.publish(event);
    return batch.length;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      let handled = 0;
      try {
        handled = await this.tick();
      } catch (err) {
        this.opts.onError?.(err);
      }
      if (this.running) this.timer = setTimeout(loop, handled >= this.batchSize ? 0 : this.pollIntervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
