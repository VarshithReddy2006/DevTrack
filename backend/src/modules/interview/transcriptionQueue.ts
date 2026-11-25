// src/modules/interview/transcriptionQueue.ts
// Rate-limited, concurrency-gated and sequence-ordered speech-to-text dispatch for interview audio chunks.

import { logger } from '../../shared/logger.js';

export type TranscriptionProvider = (audioBase64: string, context: { sessionId: string; chunkIndex: number }) => Promise<string>;

export interface TranscriptionQueueConfig {
  maxGlobalConcurrency: number;
  maxSessionConcurrency: number;
  requestsPerMinute: number;
  burstCapacity: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  finalizeTimeoutMs: number;
  sessionIdleTtlMs: number;
}

export const DEFAULT_TRANSCRIPTION_QUEUE_CONFIG: TranscriptionQueueConfig = {
  maxGlobalConcurrency: 3,
  maxSessionConcurrency: 1,
  requestsPerMinute: 50,
  burstCapacity: 5,
  maxRetries: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 15_000,
  finalizeTimeoutMs: 30_000,
  sessionIdleTtlMs: 15 * 60 * 1000,
};

export interface TranscriptionQueueDeps {
  now?: () => number;
  random?: () => number;
  onSegment?: (event: TranscriptSegmentEvent) => void;
}

export interface TranscriptSegment {
  chunkIndex: number;
  text: string;
}

export interface TranscriptSegmentEvent extends TranscriptSegment {
  sessionId: string;
  transcript: string;
}

export interface FinalTranscript {
  sessionId: string;
  transcript: string;
  segments: TranscriptSegment[];
  failedChunks: number[];
  missingChunks: number[];
  complete: boolean;
}

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

function readStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const candidate = e.status ?? e.statusCode ?? e.response?.status;
  return typeof candidate === 'number' ? candidate : undefined;
}

export function isRetryableTranscriptionError(err: unknown): boolean {
  const status = readStatusCode(err);
  return status !== undefined && RETRYABLE_STATUS_CODES.has(status);
}

/**
 * Reads a provider retry hint from `retryAfterMs` or a `Retry-After` header expressed in seconds.
 */
export function readRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as {
    retryAfterMs?: unknown;
    headers?: Record<string, unknown>;
    response?: { headers?: Record<string, unknown> };
  };
  if (typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs >= 0) {
    return e.retryAfterMs;
  }
  const headers = e.headers ?? e.response?.headers;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Exponential backoff with equal jitter: the delay lies in [cap / 2, cap] where cap = min(max, base * 2^attempt).
 */
export function computeBackoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(cap / 2 + random() * (cap / 2));
}

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    tokensPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    if (capacity < 1 || tokensPerMinute <= 0) {
      throw new Error('TokenBucket requires capacity >= 1 and a positive refill rate');
    }
    this.tokens = capacity;
    this.lastRefillAt = now();
    this.refillPerMs = tokensPerMinute / 60_000;
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefillAt);
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = current;
  }

  /**
   * Takes one token when available and returns 0, otherwise returns the milliseconds until one is available.
   */
  tryRemove(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerMs));
  }

  /** Empties the bucket, used when the provider reports throttling despite local limits. */
  drain(): void {
    this.refill();
    this.tokens = 0;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Releases transcript segments strictly in chunkIndex order regardless of completion order.
 * A null text marks a chunk that produced no transcript (silence or a permanent failure).
 */
export class TranscriptSequenceBuffer {
  private nextIndex = 0;
  private readonly held = new Map<number, string | null>();
  private readonly released: TranscriptSegment[] = [];

  accept(chunkIndex: number, text: string | null): TranscriptSegment[] {
    if (chunkIndex < this.nextIndex || this.held.has(chunkIndex)) return [];
    this.held.set(chunkIndex, text);

    const newlyReleased: TranscriptSegment[] = [];
    while (this.held.has(this.nextIndex)) {
      const value = this.held.get(this.nextIndex) ?? null;
      this.held.delete(this.nextIndex);
      if (value !== null && value.trim().length > 0) {
        const segment = { chunkIndex: this.nextIndex, text: value.trim() };
        this.released.push(segment);
        newlyReleased.push(segment);
      }
      this.nextIndex++;
    }
    return newlyReleased;
  }

  get nextExpectedIndex(): number {
    return this.nextIndex;
  }

  get segments(): TranscriptSegment[] {
    return [...this.released];
  }

  get transcript(): string {
    return this.released.map((s) => s.text).join(' ');
  }
}

interface TranscriptStream {
  generation: number;
  buffer: TranscriptSequenceBuffer;
  submitted: Set<number>;
  settled: Set<number>;
  failedChunks: Set<number>;
  finalIndex: number | null;
  cancelled: boolean;
  onSettle: (() => void) | null;
}

interface QueueItem {
  sessionId: string;
  chunkIndex: number;
  audioBase64: string;
  stream: TranscriptStream;
  attempt: number;
  notBefore: number;
  enqueueSeq: number;
  resolve: (segment: TranscriptSegment) => void;
  reject: (err: Error) => void;
}

interface SessionState {
  sessionId: string;
  pending: QueueItem[];
  inFlight: number;
  dispatched: Set<QueueItem>;
  activeStream: TranscriptStream;
  nextGeneration: number;
  lastActivityAt: number;
}

export class TranscriptionCancelledError extends Error {
  constructor(sessionId: string, chunkIndex: number) {
    super(`Transcription cancelled for session ${sessionId} chunk ${chunkIndex}`);
    this.name = 'TranscriptionCancelledError';
  }
}

export class TranscriptionQueue {
  private readonly config: TranscriptionQueueConfig;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onSegment?: (event: TranscriptSegmentEvent) => void;
  private readonly bucket: TokenBucket;
  private readonly sessions = new Map<string, SessionState>();
  private globalInFlight = 0;
  private enqueueSeq = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt = Infinity;

  constructor(
    private readonly provider: TranscriptionProvider,
    options: Partial<TranscriptionQueueConfig> = {},
    deps: TranscriptionQueueDeps = {},
  ) {
    this.config = { ...DEFAULT_TRANSCRIPTION_QUEUE_CONFIG, ...options };
    if (this.config.maxGlobalConcurrency < 1 || this.config.maxSessionConcurrency < 1) {
      throw new Error('TranscriptionQueue concurrency limits must be >= 1');
    }
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.onSegment = deps.onSegment;
    this.bucket = new TokenBucket(this.config.burstCapacity, this.config.requestsPerMinute, this.now);
  }

  /**
   * Queues one audio chunk for transcription. The returned promise settles with this chunk's text;
   * session transcripts are only ever assembled in chunkIndex order.
   */
  submit(sessionId: string, chunkIndex: number, audioBase64: string): Promise<TranscriptSegment> {
    this.assertChunkIndex(chunkIndex);
    const session = this.getOrCreateSession(sessionId);
    const stream = session.activeStream;

    if (stream.submitted.has(chunkIndex) || stream.settled.has(chunkIndex)) {
      return Promise.reject(new Error(`Chunk ${chunkIndex} already submitted for session ${sessionId}`));
    }
    stream.submitted.add(chunkIndex);

    return new Promise<TranscriptSegment>((resolve, reject) => {
      this.insertPending(session, {
        sessionId,
        chunkIndex,
        audioBase64,
        stream,
        attempt: 0,
        notBefore: 0,
        enqueueSeq: this.enqueueSeq++,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /** Marks a chunk as intentionally empty (e.g. silence) so later chunks are not held back by it. */
  skipChunk(sessionId: string, chunkIndex: number): void {
    this.assertChunkIndex(chunkIndex);
    const session = this.getOrCreateSession(sessionId);
    this.settle(session.activeStream, sessionId, chunkIndex, null);
  }

  getTranscript(sessionId: string): string {
    return this.sessions.get(sessionId)?.activeStream.buffer.transcript ?? '';
  }

  /**
   * Closes the current answer stream at lastChunkIndex and resolves once chunks 0..lastChunkIndex have
   * settled, or after finalizeTimeoutMs with any outstanding chunks reported as missing.
   * New submissions for the session start a fresh stream immediately.
   */
  finalizeSession(sessionId: string, lastChunkIndex: number, timeoutMs = this.config.finalizeTimeoutMs): Promise<FinalTranscript> {
    const session = this.getOrCreateSession(sessionId);
    const stream = session.activeStream;
    stream.finalIndex = lastChunkIndex;
    session.activeStream = this.createStream(session.nextGeneration++);

    return new Promise<FinalTranscript>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (complete: boolean) => {
        if (timer) clearTimeout(timer);
        stream.onSettle = null;
        const missingChunks: number[] = [];
        for (let i = 0; i <= lastChunkIndex; i++) {
          if (!stream.settled.has(i)) missingChunks.push(i);
        }
        if (!complete) {
          stream.cancelled = true;
          this.rejectPending(session, (item) => item.stream === stream);
          this.rejectDispatched(session, (item) => item.stream === stream);
          this.pump();
        }
        this.maybeDropSession(session);
        resolve({
          sessionId,
          transcript: stream.buffer.transcript,
          segments: stream.buffer.segments,
          failedChunks: [...stream.failedChunks].sort((a, b) => a - b),
          missingChunks,
          complete: complete && missingChunks.length === 0 && stream.failedChunks.size === 0,
        });
      };

      const isDone = () => lastChunkIndex < 0 || stream.buffer.nextExpectedIndex > lastChunkIndex;
      if (isDone()) {
        finish(true);
        return;
      }
      stream.onSettle = () => {
        if (isDone()) finish(true);
      };
      timer = setTimeout(() => {
        logger.warn('[transcription-queue] Finalize timed out with unsettled chunks', { sessionId, lastChunkIndex });
        finish(false);
      }, Math.max(0, timeoutMs));
      timer.unref?.();
    });
  }

  /** Drops all queued work and transcript state for a session (e.g. on disconnect). */
  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const item of session.pending) item.stream.cancelled = true;
    session.activeStream.cancelled = true;
    this.rejectPending(session, () => true);
    this.rejectDispatched(session, () => true);
    this.sessions.delete(sessionId);
    this.pump();
  }

  stats(): { globalInFlight: number; pending: number; sessions: number; availableTokens: number } {
    let pending = 0;
    for (const s of this.sessions.values()) pending += s.pending.length;
    return {
      globalInFlight: this.globalInFlight,
      pending,
      sessions: this.sessions.size,
      availableTokens: this.bucket.available(),
    };
  }

  /** Cancels all sessions and timers; intended for shutdown and tests. */
  close(): void {
    for (const sessionId of [...this.sessions.keys()]) this.cancelSession(sessionId);
    this.clearWakeTimer();
  }

  private assertChunkIndex(chunkIndex: number): void {
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new Error(`Invalid chunkIndex: ${chunkIndex}`);
    }
  }

  private createStream(generation: number): TranscriptStream {
    return {
      generation,
      buffer: new TranscriptSequenceBuffer(),
      submitted: new Set(),
      settled: new Set(),
      failedChunks: new Set(),
      finalIndex: null,
      cancelled: false,
      onSettle: null,
    };
  }

  private getOrCreateSession(sessionId: string): SessionState {
    this.evictIdleSessions();
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        sessionId,
        pending: [],
        inFlight: 0,
        dispatched: new Set(),
        activeStream: this.createStream(0),
        nextGeneration: 1,
        lastActivityAt: this.now(),
      };
      this.sessions.set(sessionId, session);
    }
    session.lastActivityAt = this.now();
    return session;
  }

  private evictIdleSessions(): void {
    const cutoff = this.now() - this.config.sessionIdleTtlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastActivityAt < cutoff && session.pending.length === 0 && session.inFlight === 0) {
        this.sessions.delete(id);
      }
    }
  }

  private maybeDropSession(session: SessionState): void {
    const active = session.activeStream;
    if (
      session.pending.length === 0 &&
      session.inFlight === 0 &&
      active.settled.size === 0 &&
      this.sessions.get(session.sessionId) === session
    ) {
      this.sessions.delete(session.sessionId);
    }
  }

  private insertPending(session: SessionState, item: QueueItem): void {
    const order = (a: QueueItem, b: QueueItem) =>
      a.stream.generation - b.stream.generation || a.chunkIndex - b.chunkIndex;
    const idx = session.pending.findIndex((existing) => order(item, existing) < 0);
    if (idx === -1) session.pending.push(item);
    else session.pending.splice(idx, 0, item);
  }

  private rejectPending(session: SessionState, predicate: (item: QueueItem) => boolean): void {
    const keep: QueueItem[] = [];
    for (const item of session.pending) {
      if (predicate(item)) item.reject(new TranscriptionCancelledError(item.sessionId, item.chunkIndex));
      else keep.push(item);
    }
    session.pending = keep;
  }

  /** In-flight provider calls keep their concurrency slot until they return, but their callers are released now. */
  private rejectDispatched(session: SessionState, predicate: (item: QueueItem) => boolean): void {
    for (const item of session.dispatched) {
      if (predicate(item)) {
        item.stream.cancelled = true;
        item.reject(new TranscriptionCancelledError(item.sessionId, item.chunkIndex));
      }
    }
  }

  /** Picks the session whose head chunk was enqueued first among those allowed to dispatch now. */
  private pickReadySession(now: number): { session: SessionState | null; earliestNotBefore: number } {
    let best: SessionState | null = null;
    let earliestNotBefore = Infinity;
    for (const session of this.sessions.values()) {
      const head = session.pending[0];
      if (!head || session.inFlight >= this.config.maxSessionConcurrency) continue;
      if (head.notBefore > now) {
        earliestNotBefore = Math.min(earliestNotBefore, head.notBefore);
        continue;
      }
      if (!best || head.enqueueSeq < best.pending[0].enqueueSeq) best = session;
    }
    return { session: best, earliestNotBefore };
  }

  private pump(): void {
    while (this.globalInFlight < this.config.maxGlobalConcurrency) {
      const now = this.now();
      const { session, earliestNotBefore } = this.pickReadySession(now);
      if (!session) {
        if (earliestNotBefore !== Infinity) this.scheduleWake(earliestNotBefore - now);
        return;
      }
      const waitMs = this.bucket.tryRemove();
      if (waitMs > 0) {
        this.scheduleWake(waitMs);
        return;
      }
      const item = session.pending.shift()!;
      this.dispatch(session, item);
    }
  }

  private dispatch(session: SessionState, item: QueueItem): void {
    this.globalInFlight++;
    session.inFlight++;
    session.dispatched.add(item);

    void Promise.resolve()
      .then(() => this.provider(item.audioBase64, { sessionId: item.sessionId, chunkIndex: item.chunkIndex }))
      .then(
        (text) => {
          this.release(session, item);
          if (item.stream.cancelled) {
            item.reject(new TranscriptionCancelledError(item.sessionId, item.chunkIndex));
            return;
          }
          const segment = { chunkIndex: item.chunkIndex, text: typeof text === 'string' ? text : '' };
          this.settle(item.stream, item.sessionId, item.chunkIndex, segment.text);
          item.resolve(segment);
        },
        (err: unknown) => {
          this.release(session, item);
          this.handleFailure(session, item, err);
        },
      )
      .finally(() => this.pump());
  }

  private release(session: SessionState, item: QueueItem): void {
    session.dispatched.delete(item);
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    session.inFlight = Math.max(0, session.inFlight - 1);
    session.lastActivityAt = this.now();
  }

  private handleFailure(session: SessionState, item: QueueItem, err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    if (item.stream.cancelled) {
      item.reject(new TranscriptionCancelledError(item.sessionId, item.chunkIndex));
      return;
    }

    if (isRetryableTranscriptionError(err) && item.attempt < this.config.maxRetries) {
      if (readStatusCode(err) === 429) this.bucket.drain();
      const backoff = computeBackoffDelay(item.attempt, this.config.baseBackoffMs, this.config.maxBackoffMs, this.random);
      const delay = Math.max(backoff, Math.min(readRetryAfterMs(err) ?? 0, this.config.maxBackoffMs));
      item.attempt++;
      item.notBefore = this.now() + delay;
      logger.warn('[transcription-queue] Transient provider failure; retrying chunk', {
        sessionId: item.sessionId,
        chunkIndex: item.chunkIndex,
        attempt: item.attempt,
        status: readStatusCode(err),
        delayMs: delay,
      });
      if (this.sessions.get(item.sessionId) !== session) {
        this.sessions.set(item.sessionId, session);
      }
      this.insertPending(session, item);
      return;
    }

    logger.error('[transcription-queue] Chunk transcription failed permanently', {
      sessionId: item.sessionId,
      chunkIndex: item.chunkIndex,
      attempts: item.attempt + 1,
      error: error.message,
    });
    item.stream.failedChunks.add(item.chunkIndex);
    this.settle(item.stream, item.sessionId, item.chunkIndex, null);
    this.maybeDropSession(session);
    item.reject(error);
  }

  private settle(stream: TranscriptStream, sessionId: string, chunkIndex: number, text: string | null): void {
    if (stream.cancelled || stream.settled.has(chunkIndex)) return;
    if (stream.finalIndex !== null && chunkIndex > stream.finalIndex) return;
    stream.settled.add(chunkIndex);
    let transcript = stream.buffer.transcript;
    const released = stream.buffer.accept(chunkIndex, text);
    if (this.onSegment && released.length > 0) {
      for (const segment of released) {
        transcript = transcript ? `${transcript} ${segment.text}` : segment.text;
        try {
          this.onSegment({ sessionId, ...segment, transcript });
        } catch (err) {
          logger.warn('[transcription-queue] onSegment listener failed', { sessionId, err });
        }
      }
    }
    stream.onSettle?.();
  }

  private scheduleWake(delayMs: number): void {
    const target = this.now() + Math.max(1, delayMs);
    if (this.wakeTimer && target >= this.wakeAt) return;
    this.clearWakeTimer();
    this.wakeAt = target;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeAt = Infinity;
      this.pump();
    }, Math.max(1, delayMs));
    this.wakeTimer.unref?.();
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeAt = Infinity;
  }
}
