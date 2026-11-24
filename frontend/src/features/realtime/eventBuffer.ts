// ============================================================================
// eventBuffer.ts — In-Memory SSE Event Sequence Buffer & Deduplication
// ============================================================================
// Enforces monotonic chronological event dispatch, deduplicates identical
// frames, handles out-of-order network arrival, buffers sequence gaps with
// a short timeout, and initiates replay recovery when frames are lost.
// ============================================================================

export interface SseEventEnvelope<T = Record<string, unknown>> {
  id: string;
  type: string;
  sequence: number;
  timestamp: string;
  userId?: string;
  payload?: T;
  channel?: string;
  correlationId?: string;
  schemaVersion?: number;
}

export interface EventBufferOptions<T = any> {
  /**
   * Maximum number of recent event IDs to retain in the circular deduplication set.
   * Default: 100 (prevents unbounded memory growth).
   */
  maxSeenIds?: number;
  /**
   * Maximum number of out-of-order events to buffer per channel.
   * Default: 100.
   */
  maxBufferSize?: number;
  /**
   * Window duration in milliseconds to wait for missing frames before triggering recovery.
   * Default: 200ms.
   */
  gapTimeoutMs?: number;
  /**
   * Callback invoked synchronously when an event is dispatched in strict sequence order.
   */
  onDispatch?: (envelope: SseEventEnvelope<T>, context?: any) => void;
  /**
   * Callback invoked when a sequence gap fails to resolve within the timeout window.
   */
  onGapTimeout?: (missingSequences: number[], expectedSequence: number, channel: string) => void;
  /**
   * Optional callback invoked when a duplicate event is detected and dropped.
   */
  onDuplicate?: (
    envelope: SseEventEnvelope<T>,
    reason: 'id_already_seen' | 'sequence_already_processed' | 'already_buffered'
  ) => void;
}

export interface ProcessEventResult<T = any> {
  status: 'dispatched' | 'buffered' | 'duplicate' | 'unsequenced';
  dispatched?: SseEventEnvelope<T>[];
  expected?: number;
  received?: number;
  reason?: string;
}

interface ChannelState<T> {
  lastProcessedSequence: number | null;
  bufferedEvents: Map<number, { envelope: SseEventEnvelope<T>; context?: any }>;
  gapTimer: ReturnType<typeof setTimeout> | null;
  expectedSequence: number | null;
}

export class EventSequenceBuffer<T = any> {
  private readonly maxSeenIds: number;
  private readonly maxBufferSize: number;
  private readonly gapTimeoutMs: number;
  private readonly onDispatch?: (envelope: SseEventEnvelope<T>, context?: any) => void;
  private readonly onGapTimeout?: (missingSequences: number[], expectedSequence: number, channel: string) => void;
  private readonly onDuplicate?: (
    envelope: SseEventEnvelope<T>,
    reason: 'id_already_seen' | 'sequence_already_processed' | 'already_buffered'
  ) => void;

  // Circular bounded set of recent event IDs (maxSeenIds)
  private readonly seenEventIds: Set<string> = new Set();
  // Per-channel buffer and sequence state
  private readonly channels: Map<string, ChannelState<T>> = new Map();
  // Monotonically tracked replay checkpoint (ID of last dispatched in-order event)
  private lastDispatchedCheckpoint: string | null = null;

  constructor(options: EventBufferOptions<T> = {}) {
    this.maxSeenIds = options.maxSeenIds ?? 100;
    this.maxBufferSize = options.maxBufferSize ?? 100;
    this.gapTimeoutMs = options.gapTimeoutMs ?? 200;
    this.onDispatch = options.onDispatch;
    this.onGapTimeout = options.onGapTimeout;
    this.onDuplicate = options.onDuplicate;
  }

  /**
   * Process an incoming event envelope through deduplication, sequencing, and gap buffering.
   */
  public processEvent(envelope: SseEventEnvelope<T>, context?: any): ProcessEventResult<T> {
    // 1. Deduplicate by event ID
    if (envelope.id && this.seenEventIds.has(envelope.id)) {
      this.onDuplicate?.(envelope, 'id_already_seen');
      return { status: 'duplicate', reason: 'id_already_seen' };
    }

    const seq = envelope.sequence;

    // 2. Handle unsequenced events (legacy payloads or runtime_state_full with seq === 0)
    if (seq === undefined || seq === null || seq <= 0) {
      if (envelope.id) {
        this.rememberId(envelope.id);
        this.lastDispatchedCheckpoint = envelope.id;
      }

      // If full state baseline arrives, reset sequence tracking for this channel
      if (envelope.type === 'runtime_state_full' || seq === 0) {
        const channelState = this.getChannelState(envelope.channel || 'default');
        this.clearGapTimer(channelState);
        channelState.bufferedEvents.clear();
        channelState.lastProcessedSequence = null;
        channelState.expectedSequence = null;
      }

      this.onDispatch?.(envelope, context);
      return { status: 'unsequenced', dispatched: [envelope] };
    }

    const channelName = envelope.channel || 'default';
    const channel = this.getChannelState(channelName);

    // 3. First sequenced event received on this channel
    if (channel.lastProcessedSequence === null) {
      if (envelope.id) this.rememberId(envelope.id);
      channel.lastProcessedSequence = seq;
      this.lastDispatchedCheckpoint = envelope.id;
      const dispatched: SseEventEnvelope<T>[] = [envelope];
      this.onDispatch?.(envelope, context);

      const drained = this.drainConsecutive(channel);
      dispatched.push(...drained);

      return { status: 'dispatched', dispatched };
    }

    // 4. Duplicate or stale sequence number (already processed)
    if (seq <= channel.lastProcessedSequence) {
      if (envelope.id) this.rememberId(envelope.id);
      this.onDuplicate?.(envelope, 'sequence_already_processed');
      return { status: 'duplicate', reason: 'sequence_already_processed' };
    }

    // 5. In-order arrival (expected sequence = lastProcessedSequence + 1)
    if (seq === channel.lastProcessedSequence + 1) {
      if (envelope.id) this.rememberId(envelope.id);
      channel.lastProcessedSequence = seq;
      this.lastDispatchedCheckpoint = envelope.id;
      const dispatched: SseEventEnvelope<T>[] = [envelope];
      this.onDispatch?.(envelope, context);

      const drained = this.drainConsecutive(channel);
      dispatched.push(...drained);

      return { status: 'dispatched', dispatched };
    }

    // 6. Out-of-order sequence GAP (seq > lastProcessedSequence + 1)
    if (channel.bufferedEvents.has(seq)) {
      this.onDuplicate?.(envelope, 'already_buffered');
      return { status: 'duplicate', reason: 'already_buffered' };
    }

    // Prevent unbounded memory growth if buffer is full
    if (channel.bufferedEvents.size >= this.maxBufferSize) {
      this.triggerGapRecovery(channel, channelName);
      return {
        status: 'buffered',
        expected: channel.lastProcessedSequence + 1,
        received: seq,
      };
    }

    channel.bufferedEvents.set(seq, { envelope, context });
    if (envelope.id) this.rememberId(envelope.id);

    // Start gap recovery timer if not already active
    if (channel.gapTimer === null) {
      channel.expectedSequence = channel.lastProcessedSequence + 1;
      channel.gapTimer = setTimeout(() => {
        this.triggerGapRecovery(channel, channelName);
      }, this.gapTimeoutMs);
    }

    return {
      status: 'buffered',
      expected: channel.lastProcessedSequence + 1,
      received: seq,
    };
  }

  /**
   * Drains consecutive buffered events starting from lastProcessedSequence + 1.
   */
  private drainConsecutive(channel: ChannelState<T>): SseEventEnvelope<T>[] {
    const drained: SseEventEnvelope<T>[] = [];

    while (
      channel.lastProcessedSequence !== null &&
      channel.bufferedEvents.has(channel.lastProcessedSequence + 1)
    ) {
      const nextSeq = channel.lastProcessedSequence + 1;
      const item = channel.bufferedEvents.get(nextSeq)!;
      channel.bufferedEvents.delete(nextSeq);
      channel.lastProcessedSequence = nextSeq;
      this.lastDispatchedCheckpoint = item.envelope.id;
      drained.push(item.envelope);
      this.onDispatch?.(item.envelope, item.context);
    }

    if (channel.bufferedEvents.size === 0) {
      this.clearGapTimer(channel);
    } else if (channel.gapTimer !== null && channel.lastProcessedSequence !== null) {
      // Advance the expected sequence for any remaining higher gaps
      channel.expectedSequence = channel.lastProcessedSequence + 1;
    }

    return drained;
  }

  /**
   * Invoked when a gap timer expires or buffer capacity forces recovery.
   */
  private triggerGapRecovery(channel: ChannelState<T>, channelName: string): void {
    this.clearGapTimer(channel);
    if (channel.lastProcessedSequence === null) return;

    const expected = channel.lastProcessedSequence + 1;
    const bufferedKeys = Array.from(channel.bufferedEvents.keys()).sort((a, b) => a - b);
    const minBuffered = bufferedKeys.length > 0 ? bufferedKeys[0] : expected;
    const missing: number[] = [];

    for (let s = expected; s < minBuffered; s++) {
      missing.push(s);
    }
    if (missing.length === 0) {
      missing.push(expected);
    }

    this.onGapTimeout?.(missing, expected, channelName);
  }

  /**
   * Retain up to maxSeenIds in a circular/bounded FIFO set.
   */
  private rememberId(id: string): void {
    if (this.seenEventIds.has(id)) return;
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > this.maxSeenIds) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest !== undefined) {
        this.seenEventIds.delete(oldest);
      }
    }
  }

  private getChannelState(channel: string = 'default'): ChannelState<T> {
    let state = this.channels.get(channel);
    if (!state) {
      state = {
        lastProcessedSequence: null,
        bufferedEvents: new Map(),
        gapTimer: null,
        expectedSequence: null,
      };
      this.channels.set(channel, state);
    }
    return state;
  }

  private clearGapTimer(channel: ChannelState<T>): void {
    if (channel.gapTimer !== null) {
      clearTimeout(channel.gapTimer);
      channel.gapTimer = null;
    }
  }

  /**
   * Returns whether an event ID has already been seen and processed.
   */
  public hasSeenId(id: string): boolean {
    return this.seenEventIds.has(id);
  }

  /**
   * The Redis Stream ID of the most recently dispatched event in strict sequential order.
   * This is the exact replay checkpoint that should be used as Last-Event-ID on reconnection.
   */
  public getLastDispatchedCheckpoint(): string | null {
    return this.lastDispatchedCheckpoint;
  }

  /**
   * Returns the highest processed sequence number for a given channel.
   */
  public getLastProcessedSequence(channel: string = 'default'): number | null {
    return this.channels.get(channel)?.lastProcessedSequence ?? null;
  }

  /**
   * Returns the count of out-of-order events currently buffered for a given channel.
   */
  public getBufferSize(channel: string = 'default'): number {
    return this.channels.get(channel)?.bufferedEvents.size ?? 0;
  }

  /**
   * Returns all currently buffered events for a given channel in sequence order.
   */
  public getBufferedEvents(channel: string = 'default'): SseEventEnvelope<T>[] {
    const channelState = this.channels.get(channel);
    if (!channelState) return [];
    return Array.from(channelState.bufferedEvents.entries())
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item.envelope);
  }

  /**
   * Cancels all active gap timers across all channels without discarding buffered events.
   * Use during stream reconnection so timers do not fire while offline.
   */
  public clearTimers(): void {
    for (const channel of this.channels.values()) {
      this.clearGapTimer(channel);
    }
  }

  /**
   * Resets all sequence and buffer state for a specific channel.
   */
  public resetChannel(channel: string = 'default'): void {
    const channelState = this.channels.get(channel);
    if (channelState) {
      this.clearGapTimer(channelState);
      channelState.bufferedEvents.clear();
      channelState.lastProcessedSequence = null;
      channelState.expectedSequence = null;
    }
  }

  /**
   * Completely resets all state, clears all timers, drops all buffered events and seen IDs.
   * Use on logout, genuine disconnect, or test tear-down.
   */
  public clear(): void {
    this.clearTimers();
    this.channels.clear();
    this.seenEventIds.clear();
    this.lastDispatchedCheckpoint = null;
  }

  /**
   * Alias for clear() to safely tear down the buffer instance.
   */
  public destroy(): void {
    this.clear();
  }
}
