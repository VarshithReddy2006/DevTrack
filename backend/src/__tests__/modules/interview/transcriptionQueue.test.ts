// src/__tests__/modules/interview/transcriptionQueue.test.ts
// Ordering, rate limiting, concurrency and retry tests for the interview speech-to-text queue.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TokenBucket,
  TranscriptSequenceBuffer,
  TranscriptionCancelledError,
  TranscriptionQueue,
  computeBackoffDelay,
  isRetryableTranscriptionError,
  readRetryAfterMs,
  type TranscriptionProvider,
} from '../../../modules/interview/transcriptionQueue.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function providerError(status: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`provider status ${status}`), { status, ...extra });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Provider whose calls stay pending until the test resolves them explicitly. */
function controllableProvider() {
  const calls: Array<{ sessionId: string; chunkIndex: number; audioBase64: string; d: Deferred<string> }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const perSession = new Map<string, number>();
  let maxPerSession = 0;

  const provider: TranscriptionProvider = (audioBase64, { sessionId, chunkIndex }) => {
    const d = deferred<string>();
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const sessionCount = (perSession.get(sessionId) ?? 0) + 1;
    perSession.set(sessionId, sessionCount);
    maxPerSession = Math.max(maxPerSession, sessionCount);
    calls.push({ sessionId, chunkIndex, audioBase64, d });
    return d.promise.finally(() => {
      inFlight--;
      perSession.set(sessionId, (perSession.get(sessionId) ?? 1) - 1);
    });
  };

  return {
    provider,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    get maxPerSession() {
      return maxPerSession;
    },
  };
}

const unlimitedRate = { requestsPerMinute: 60_000, burstCapacity: 1_000 };

describe('transcriptionQueue helpers', () => {
  it('TokenBucket allows a burst then reports the wait until the next token', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 60, () => now); // 1 token per second

    expect(bucket.tryRemove()).toBe(0);
    expect(bucket.tryRemove()).toBe(0);
    expect(bucket.tryRemove()).toBe(1000);

    now = 500;
    expect(bucket.tryRemove()).toBe(500);
    now = 1000;
    expect(bucket.tryRemove()).toBe(0);

    now = 10_000;
    expect(bucket.available()).toBe(2); // capped at capacity
    bucket.drain();
    expect(bucket.available()).toBe(0);
  });

  it('TokenBucket rejects invalid configuration', () => {
    expect(() => new TokenBucket(0, 10)).toThrow();
    expect(() => new TokenBucket(1, 0)).toThrow();
  });

  it('computeBackoffDelay grows exponentially with bounded jitter and a cap', () => {
    expect(computeBackoffDelay(0, 500, 15_000, () => 0)).toBe(250);
    expect(computeBackoffDelay(0, 500, 15_000, () => 1)).toBe(500);
    expect(computeBackoffDelay(3, 500, 15_000, () => 0)).toBe(2000);
    expect(computeBackoffDelay(3, 500, 15_000, () => 1)).toBe(4000);
    expect(computeBackoffDelay(20, 500, 15_000, () => 1)).toBe(15_000);
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelay(2, 500, 15_000);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });

  it('classifies only throttling and unavailable provider errors as retryable', () => {
    expect(isRetryableTranscriptionError(providerError(429))).toBe(true);
    expect(isRetryableTranscriptionError(providerError(503))).toBe(true);
    expect(isRetryableTranscriptionError({ response: { status: 503 } })).toBe(true);
    expect(isRetryableTranscriptionError({ statusCode: 502 })).toBe(true);
    expect(isRetryableTranscriptionError(providerError(400))).toBe(false);
    expect(isRetryableTranscriptionError(providerError(401))).toBe(false);
    expect(isRetryableTranscriptionError(new Error('boom'))).toBe(false);
    expect(isRetryableTranscriptionError(null)).toBe(false);
  });

  it('reads Retry-After hints in milliseconds', () => {
    expect(readRetryAfterMs({ retryAfterMs: 1200 })).toBe(1200);
    expect(readRetryAfterMs({ headers: { 'retry-after': '3' } })).toBe(3000);
    expect(readRetryAfterMs({ response: { headers: { 'Retry-After': 2 } } })).toBe(2000);
    expect(readRetryAfterMs({ headers: { 'retry-after': 'soon' } })).toBeUndefined();
    expect(readRetryAfterMs(undefined)).toBeUndefined();
  });

  it('TranscriptSequenceBuffer releases segments strictly in chunkIndex order', () => {
    const buffer = new TranscriptSequenceBuffer();
    expect(buffer.accept(2, 'three')).toEqual([]);
    expect(buffer.accept(1, 'two')).toEqual([]);
    expect(buffer.transcript).toBe('');

    expect(buffer.accept(0, 'one')).toEqual([
      { chunkIndex: 0, text: 'one' },
      { chunkIndex: 1, text: 'two' },
      { chunkIndex: 2, text: 'three' },
    ]);
    expect(buffer.accept(3, null)).toEqual([]);
    expect(buffer.accept(4, '  five ')).toEqual([{ chunkIndex: 4, text: 'five' }]);
    expect(buffer.accept(1, 'late duplicate')).toEqual([]);
    expect(buffer.transcript).toBe('one two three five');
    expect(buffer.nextExpectedIndex).toBe(5);
  });
});

describe('TranscriptionQueue', () => {
  let queue: TranscriptionQueue | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    queue?.close();
    queue = null;
    vi.useRealTimers();
  });

  it('caps global concurrency and keeps at most one in-flight request per session', async () => {
    const p = controllableProvider();
    queue = new TranscriptionQueue(p.provider, { ...unlimitedRate, maxGlobalConcurrency: 3, maxSessionConcurrency: 1 });

    const results: Promise<unknown>[] = [];
    for (let s = 0; s < 5; s++) {
      for (let c = 0; c < 3; c++) results.push(queue.submit(`session-${s}`, c, `audio-${s}-${c}`));
    }
    await flush();

    expect(p.calls).toHaveLength(3);
    expect(new Set(p.calls.map((c) => c.sessionId)).size).toBe(3);
    expect(queue.stats()).toMatchObject({ globalInFlight: 3, pending: 12 });

    while (p.calls.some((c) => c.d)) {
      const next = p.calls.shift();
      if (!next) break;
      next.d.resolve(`text-${next.sessionId}-${next.chunkIndex}`);
      await flush();
    }
    await Promise.all(results);

    expect(p.maxInFlight).toBe(3);
    expect(p.maxPerSession).toBe(1);
    for (let s = 0; s < 5; s++) {
      expect(queue.getTranscript(`session-${s}`)).toBe(
        `text-session-${s}-0 text-session-${s}-1 text-session-${s}-2`,
      );
    }
  });

  it('dispatches each session in chunkIndex order even when chunks are submitted out of order', async () => {
    const order: number[] = [];
    queue = new TranscriptionQueue(async (_audio, { chunkIndex }) => {
      order.push(chunkIndex);
      return `w${chunkIndex}`;
    }, unlimitedRate);

    const p2 = queue.submit('s', 2, 'a2');
    const p0 = queue.submit('s', 0, 'a0');
    const p1 = queue.submit('s', 1, 'a1');
    await Promise.all([p0, p1, p2]);

    // Chunk 2 may start first because it arrived alone, but the transcript is still stitched 0, 1, 2.
    expect(order.slice(1)).toEqual([0, 1]);
    expect(queue.getTranscript('s')).toBe('w0 w1 w2');
  });

  it('sorts out-of-order provider responses before assembling the transcript', async () => {
    const p = controllableProvider();
    const segments: Array<{ chunkIndex: number; transcript: string }> = [];
    queue = new TranscriptionQueue(
      p.provider,
      { ...unlimitedRate, maxSessionConcurrency: 3 },
      { onSegment: (e) => segments.push({ chunkIndex: e.chunkIndex, transcript: e.transcript }) },
    );

    const all = [0, 1, 2].map((i) => queue!.submit('jitter', i, `a${i}`));
    await flush();
    expect(p.calls.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);

    // Network jitter: chunk 2 returns first, then 1, then 0.
    p.calls[2].d.resolve('world');
    await flush();
    p.calls[1].d.resolve('hello');
    await flush();
    expect(queue.getTranscript('jitter')).toBe('');
    expect(segments).toEqual([]);

    p.calls[0].d.resolve('Well');
    await Promise.all(all);

    expect(queue.getTranscript('jitter')).toBe('Well hello world');
    expect(segments).toEqual([
      { chunkIndex: 0, transcript: 'Well' },
      { chunkIndex: 1, transcript: 'Well hello' },
      { chunkIndex: 2, transcript: 'Well hello world' },
    ]);
  });

  it('throttles dispatch with the token bucket instead of exceeding the provider rate', async () => {
    const dispatchedAt: number[] = [];
    queue = new TranscriptionQueue(
      async (_audio, { chunkIndex }) => {
        dispatchedAt.push(Date.now());
        return `c${chunkIndex}`;
      },
      { requestsPerMinute: 60, burstCapacity: 2, maxGlobalConcurrency: 3, maxSessionConcurrency: 3 },
    );
    const start = Date.now();

    const all = [0, 1, 2, 3].map((i) => queue!.submit('rate', i, `a${i}`));
    await flush();
    expect(dispatchedAt).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(dispatchedAt).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatchedAt).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(all);

    expect(dispatchedAt.map((t) => t - start)).toEqual([0, 0, 1000, 2000]);
    expect(queue.getTranscript('rate')).toBe('c0 c1 c2 c3');
  });

  it('retries 429 and 503 responses with backoff and never drops the chunk', async () => {
    const attempts: Array<{ chunkIndex: number; at: number }> = [];
    let failuresLeft = 2;
    queue = new TranscriptionQueue(
      async (_audio, { chunkIndex }) => {
        attempts.push({ chunkIndex, at: Date.now() });
        if (chunkIndex === 0 && failuresLeft > 0) {
          failuresLeft--;
          throw providerError(failuresLeft === 1 ? 429 : 503);
        }
        return `ok${chunkIndex}`;
      },
      { ...unlimitedRate, baseBackoffMs: 1000, maxBackoffMs: 10_000 },
      { random: () => 1 },
    );
    const start = Date.now();

    const p0 = queue.submit('retry', 0, 'a0');
    const p1 = queue.submit('retry', 1, 'a1');
    await flush();
    expect(attempts).toEqual([{ chunkIndex: 0, at: start }]);

    // Chunk 1 must not overtake chunk 0 while it is backing off.
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(p0).resolves.toEqual({ chunkIndex: 0, text: 'ok0' });
    await expect(p1).resolves.toEqual({ chunkIndex: 1, text: 'ok1' });
    expect(attempts.map((a) => [a.chunkIndex, a.at - start])).toEqual([
      [0, 0],
      [0, 1000],
      [0, 3000],
      [1, 3000],
    ]);
    expect(queue.getTranscript('retry')).toBe('ok0 ok1');
  });

  it('honours Retry-After and drains the shared bucket after a 429', async () => {
    const attempts: number[] = [];
    let throttled = false;
    queue = new TranscriptionQueue(
      async () => {
        attempts.push(Date.now());
        if (!throttled) {
          throttled = true;
          throw providerError(429, { headers: { 'retry-after': '4' } });
        }
        return 'done';
      },
      { requestsPerMinute: 600, burstCapacity: 5, baseBackoffMs: 100 },
      { random: () => 0 },
    );
    const start = Date.now();

    const result = queue.submit('hint', 0, 'a0');
    await flush();
    expect(queue.stats().availableTokens).toBeLessThan(1);

    await vi.advanceTimersByTimeAsync(3999);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ chunkIndex: 0, text: 'done' });
    expect(attempts.map((t) => t - start)).toEqual([0, 4000]);
  });

  it('fails non-retryable errors without blocking later segments', async () => {
    queue = new TranscriptionQueue(async (_audio, { chunkIndex }) => {
      if (chunkIndex === 1) throw providerError(400);
      return `t${chunkIndex}`;
    }, unlimitedRate);

    const results = await Promise.allSettled([0, 1, 2].map((i) => queue!.submit('bad', i, `a${i}`)));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(queue.getTranscript('bad')).toBe('t0 t2');

    const final = await queue.finalizeSession('bad', 2);
    expect(final).toMatchObject({ transcript: 't0 t2', failedChunks: [1], missingChunks: [], complete: false });
  });

  it('gives up after maxRetries transient failures', async () => {
    const provider = vi.fn(async () => {
      throw providerError(503);
    });
    queue = new TranscriptionQueue(provider, { ...unlimitedRate, maxRetries: 2, baseBackoffMs: 10 }, { random: () => 1 });

    const result = queue.submit('down', 0, 'a0');
    const assertion = expect(result).rejects.toThrow('provider status 503');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(provider).toHaveBeenCalledTimes(3);
  });

  it('skips silent chunks so they never hold back the ordered transcript', async () => {
    queue = new TranscriptionQueue(async (_audio, { chunkIndex }) => `v${chunkIndex}`, unlimitedRate);
    queue.skipChunk('quiet', 0);
    const p2 = queue.submit('quiet', 2, 'a2');
    queue.skipChunk('quiet', 1);
    await p2;
    expect(queue.getTranscript('quiet')).toBe('v2');
  });

  it('rejects duplicate and invalid submissions', async () => {
    const p = controllableProvider();
    queue = new TranscriptionQueue(p.provider, unlimitedRate);
    const first = queue.submit('dup', 0, 'a0');
    await expect(queue.submit('dup', 0, 'a0')).rejects.toThrow('already submitted');
    expect(() => queue!.submit('dup', -1, 'a')).toThrow('Invalid chunkIndex');
    expect(() => queue!.skipChunk('dup', 1.5)).toThrow('Invalid chunkIndex');
    await flush();
    p.calls[0].d.resolve('x');
    await first;
  });

  it('finalizeSession waits for in-flight chunks and starts a fresh stream for the next answer', async () => {
    const p = controllableProvider();
    queue = new TranscriptionQueue(p.provider, { ...unlimitedRate, maxSessionConcurrency: 1 });

    const a0 = queue.submit('answers', 0, 'a0');
    const a1 = queue.submit('answers', 1, 'a1');
    const final = queue.finalizeSession('answers', 1);

    // The next answer restarts at chunkIndex 0 without colliding with the previous stream.
    const b0 = queue.submit('answers', 0, 'b0');
    await flush();
    expect(p.calls.map((c) => c.audioBase64)).toEqual(['a0']);

    p.calls[0].d.resolve('first');
    await flush();
    expect(p.calls.map((c) => c.audioBase64)).toEqual(['a0', 'a1']);
    p.calls[1].d.resolve('answer');
    await flush();
    p.calls[2].d.resolve('second');
    await Promise.all([a0, a1, b0]);

    await expect(final).resolves.toMatchObject({
      sessionId: 'answers',
      transcript: 'first answer',
      failedChunks: [],
      missingChunks: [],
      complete: true,
    });
    expect(queue.getTranscript('answers')).toBe('second');
  });

  it('advances through missing chunks after repeated sequence gap timeouts', async () => {
    queue = new TranscriptionQueue(async () => 'later text', { ...unlimitedRate, gapTimeoutMs: 5000 });

    await queue.submit('gap-timeout', 2, 'audio-2');
    expect(queue.getTranscript('gap-timeout')).toBe('');

    await vi.advanceTimersByTimeAsync(5000);
    expect(queue.getTranscript('gap-timeout')).toBe('');

    await vi.advanceTimersByTimeAsync(5000);

    expect(queue.getTranscript('gap-timeout')).toBe('later text');
    await expect(queue.finalizeSession('gap-timeout', 2)).resolves.toMatchObject({
      transcript: 'later text',
      missingChunks: [0, 1],
      complete: false,
    });
  });

  it('rejects chunks outside the per-session sequence window', async () => {
    queue = new TranscriptionQueue(async (_audio, { chunkIndex }) => `text-${chunkIndex}`, {
      ...unlimitedRate,
      maxWindowSize: 10,
    });

    await Promise.all(Array.from({ length: 9 }, (_, index) => queue!.submit('window', index + 1, 'audio')));
    await expect(queue.submit('window', 10, 'audio')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('rejects chunks that exceed the per-session buffered byte limit', async () => {
    const p = controllableProvider();
    queue = new TranscriptionQueue(p.provider, {
      ...unlimitedRate,
      maxBufferedBytesPerSession: 5,
    });

    const first = queue.submit('bytes', 0, '1234');
    const overflow = queue.submit('bytes', 1, 'ab');
    const firstCancelled = expect(first).rejects.toBeInstanceOf(TranscriptionCancelledError);
    const overflowRejected = expect(overflow).rejects.toMatchObject({ statusCode: 429 });

    queue.cancelSession('bytes');
    await Promise.all([firstCancelled, overflowRejected]);
  });

  it('finalizeSession reports missing chunks after the timeout and cancels their pending work', async () => {
    const p = controllableProvider();
    queue = new TranscriptionQueue(p.provider, unlimitedRate);

    const c0 = queue.submit('gap', 0, 'a0');
    const c2 = queue.submit('gap', 2, 'a2');
    const final = queue.finalizeSession('gap', 2, 5000);
    await flush();
    p.calls[0].d.resolve('zero');
    await c0;
    const c2Cancelled = expect(c2).rejects.toBeInstanceOf(TranscriptionCancelledError);

    await vi.advanceTimersByTimeAsync(5000);
    await expect(final).resolves.toMatchObject({
      transcript: 'zero',
      missingChunks: [1, 2],
      complete: false,
    });
    await c2Cancelled;
  });

  it('cancelSession rejects queued chunks and discards in-flight results', async () => {
    const p = controllableProvider();
    queue = new TranscriptionQueue(p.provider, unlimitedRate);

    const c0 = queue.submit('gone', 0, 'a0');
    const c1 = queue.submit('gone', 1, 'a1');
    await flush();
    queue.cancelSession('gone');

    await expect(c1).rejects.toBeInstanceOf(TranscriptionCancelledError);
    p.calls[0].d.resolve('late');
    await expect(c0).rejects.toBeInstanceOf(TranscriptionCancelledError);
    expect(queue.getTranscript('gone')).toBe('');
    expect(queue.stats()).toMatchObject({ globalInFlight: 0, pending: 0, sessions: 0 });
  });

  it('treats synchronous provider throws as permanent failures', async () => {
    queue = new TranscriptionQueue((() => {
      throw new Error('sync failure');
    }) as TranscriptionProvider, unlimitedRate);
    await expect(queue.submit('sync', 0, 'a0')).rejects.toThrow('sync failure');
    expect(queue.stats().globalInFlight).toBe(0);
  });
});
