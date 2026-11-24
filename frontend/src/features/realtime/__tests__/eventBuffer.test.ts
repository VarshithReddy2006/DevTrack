import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventSequenceBuffer, type SseEventEnvelope } from '../eventBuffer';

function makeEnvelope(
  sequence: number,
  id = `stream-${sequence}`,
  type = 'xp_updated',
  channel = 'default',
  payload: Record<string, unknown> = {}
): SseEventEnvelope {
  return {
    id,
    type,
    sequence,
    timestamp: new Date().toISOString(),
    userId: 'user_123',
    channel,
    payload,
  };
}

describe('EventSequenceBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Normal sequential delivery
  it('dispatches events immediately when received in normal sequence order', () => {
    const dispatched: SseEventEnvelope[] = [];
    const buffer = new EventSequenceBuffer({
      onDispatch: (env) => dispatched.push(env),
    });

    const e1 = makeEnvelope(1);
    const e2 = makeEnvelope(2);
    const e3 = makeEnvelope(3);

    const r1 = buffer.processEvent(e1);
    expect(r1.status).toBe('dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].id).toBe('stream-1');
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-1');

    const r2 = buffer.processEvent(e2);
    expect(r2.status).toBe('dispatched');
    expect(dispatched).toHaveLength(2);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-2');

    const r3 = buffer.processEvent(e3);
    expect(r3.status).toBe('dispatched');
    expect(dispatched).toHaveLength(3);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-3');
  });

  // 2. Duplicate sequence numbers
  it('detects and ignores duplicate sequence numbers that have already been processed', () => {
    const dispatched: SseEventEnvelope[] = [];
    const onDuplicate = vi.fn();
    const buffer = new EventSequenceBuffer({
      onDispatch: (env) => dispatched.push(env),
      onDuplicate,
    });

    buffer.processEvent(makeEnvelope(1));
    buffer.processEvent(makeEnvelope(2));
    buffer.processEvent(makeEnvelope(3));
    expect(dispatched).toHaveLength(3);

    // Stale sequence 2 arrives again with a different ID
    const duplicate = makeEnvelope(2, 'stream-2-dup');
    const res = buffer.processEvent(duplicate);

    expect(res.status).toBe('duplicate');
    expect(res.reason).toBe('sequence_already_processed');
    expect(dispatched).toHaveLength(3);
    expect(onDuplicate).toHaveBeenCalledWith(duplicate, 'sequence_already_processed');
  });

  // 3. Duplicate event IDs
  it('detects and discards duplicate events sharing the same event ID', () => {
    const dispatched: SseEventEnvelope[] = [];
    const onDuplicate = vi.fn();
    const buffer = new EventSequenceBuffer({
      onDispatch: (env) => dispatched.push(env),
      onDuplicate,
    });

    const e1 = makeEnvelope(1, 'stream-unique-1');
    buffer.processEvent(e1);
    expect(dispatched).toHaveLength(1);

    // Same ID arrives again
    const dup = makeEnvelope(1, 'stream-unique-1');
    const res = buffer.processEvent(dup);

    expect(res.status).toBe('duplicate');
    expect(res.reason).toBe('id_already_seen');
    expect(dispatched).toHaveLength(1);
    expect(onDuplicate).toHaveBeenCalledWith(dup, 'id_already_seen');
  });

  // 4. Out-of-order events: 1, 2, 5, 4, 3 -> 1, 2, 3, 4, 5
  it('handles out-of-order delivery and dispatches strictly in sequence order', () => {
    const dispatched: SseEventEnvelope[] = [];
    const buffer = new EventSequenceBuffer({
      onDispatch: (env) => dispatched.push(env),
    });

    buffer.processEvent(makeEnvelope(1));
    buffer.processEvent(makeEnvelope(2));
    expect(dispatched.map((e) => e.sequence)).toEqual([1, 2]);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-2');

    // 5 arrives before 3 and 4 -> buffered
    const r5 = buffer.processEvent(makeEnvelope(5));
    expect(r5.status).toBe('buffered');
    expect(buffer.getBufferSize()).toBe(1);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-2'); // Checkpoint untouched!

    // 4 arrives before 3 -> buffered
    const r4 = buffer.processEvent(makeEnvelope(4));
    expect(r4.status).toBe('buffered');
    expect(buffer.getBufferSize()).toBe(2);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-2'); // Checkpoint still untouched!
    expect(dispatched.map((e) => e.sequence)).toEqual([1, 2]);

    // 3 arrives -> completes the gap and drains 4 and 5 in sequence
    const r3 = buffer.processEvent(makeEnvelope(3));
    expect(r3.status).toBe('dispatched');
    expect(dispatched.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(buffer.getBufferSize()).toBe(0);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-5');
  });

  // 5. Missing sequence detection
  it('detects missing sequence numbers and reports expected vs received', () => {
    const buffer = new EventSequenceBuffer();
    buffer.processEvent(makeEnvelope(1));

    const result = buffer.processEvent(makeEnvelope(4));
    expect(result.status).toBe('buffered');
    expect(result.expected).toBe(2);
    expect(result.received).toBe(4);
  });

  // 6. Gap timeout and recovery trigger
  it('triggers gap recovery when a missing event does not arrive within the timeout', () => {
    const onGapTimeout = vi.fn();
    const buffer = new EventSequenceBuffer({
      gapTimeoutMs: 200,
      onGapTimeout,
    });

    buffer.processEvent(makeEnvelope(1));
    buffer.processEvent(makeEnvelope(2));
    buffer.processEvent(makeEnvelope(5)); // Missing 3 and 4

    expect(onGapTimeout).not.toHaveBeenCalled();

    // Advance timer past gap window
    vi.advanceTimersByTime(200);

    expect(onGapTimeout).toHaveBeenCalledTimes(1);
    expect(onGapTimeout).toHaveBeenCalledWith([3, 4], 3, 'default');
  });

  // 7. Recovery when missing events arrive before timeout
  it('cancels gap timeout when missing events arrive within the window', () => {
    const onGapTimeout = vi.fn();
    const dispatched: SseEventEnvelope[] = [];
    const buffer = new EventSequenceBuffer({
      gapTimeoutMs: 200,
      onDispatch: (e) => dispatched.push(e),
      onGapTimeout,
    });

    buffer.processEvent(makeEnvelope(1));
    buffer.processEvent(makeEnvelope(3)); // Missing 2

    // 100ms later, missing event 2 arrives
    vi.advanceTimersByTime(100);
    buffer.processEvent(makeEnvelope(2));

    expect(dispatched.map((e) => e.sequence)).toEqual([1, 2, 3]);

    // Advance another 150ms (total 250ms)
    vi.advanceTimersByTime(150);

    // Timeout should not have fired because gap was resolved
    expect(onGapTimeout).not.toHaveBeenCalled();
  });

  // 8. Multiple missing events
  it('identifies all missing sequence numbers when multiple events are missing', () => {
    const onGapTimeout = vi.fn();
    const buffer = new EventSequenceBuffer({
      gapTimeoutMs: 200,
      onGapTimeout,
    });

    buffer.processEvent(makeEnvelope(1));
    buffer.processEvent(makeEnvelope(6)); // Missing 2, 3, 4, 5

    vi.advanceTimersByTime(200);

    expect(onGapTimeout).toHaveBeenCalledWith([2, 3, 4, 5], 2, 'default');
  });

  // 9. Buffer capacity limits
  it('triggers gap recovery when buffer capacity limit is reached to prevent unbounded growth', () => {
    const onGapTimeout = vi.fn();
    const buffer = new EventSequenceBuffer({
      maxBufferSize: 3,
      gapTimeoutMs: 10_000,
      onGapTimeout,
    });

    buffer.processEvent(makeEnvelope(1));
    buffer.processEvent(makeEnvelope(3));
    buffer.processEvent(makeEnvelope(4));
    buffer.processEvent(makeEnvelope(5));

    expect(buffer.getBufferSize()).toBe(3);
    expect(onGapTimeout).not.toHaveBeenCalled();

    // 4th buffered event exceeds maxBufferSize 3
    buffer.processEvent(makeEnvelope(6));

    expect(onGapTimeout).toHaveBeenCalledTimes(1);
    expect(onGapTimeout).toHaveBeenCalledWith([2], 2, 'default');
  });

  // 10. Memory bounding via circular set
  it('caps seenEventIds to maxSeenIds by dropping the oldest entries', () => {
    const buffer = new EventSequenceBuffer({
      maxSeenIds: 5,
    });

    for (let i = 1; i <= 5; i++) {
      buffer.processEvent(makeEnvelope(i, `id-${i}`));
      expect(buffer.hasSeenId(`id-${i}`)).toBe(true);
    }

    // Process 6th event -> oldest ('id-1') should be evicted from seen set
    buffer.processEvent(makeEnvelope(6, 'id-6'));
    expect(buffer.hasSeenId('id-6')).toBe(true);
    expect(buffer.hasSeenId('id-1')).toBe(false);
  });

  // 11. Preserving pending buffered events across reconnects
  it('preserves pending buffered events when clearTimers is called during reconnect', () => {
    const dispatched: SseEventEnvelope[] = [];
    const buffer = new EventSequenceBuffer({
      onDispatch: (e) => dispatched.push(e),
    });

    buffer.processEvent(makeEnvelope(1));
    buffer.processEvent(makeEnvelope(2));
    buffer.processEvent(makeEnvelope(4)); // 4 is buffered, waiting for 3

    expect(buffer.getBufferSize()).toBe(1);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-2');

    // Simulate transient stream reconnect: pause timers
    buffer.clearTimers();
    expect(buffer.getBufferSize()).toBe(1); // Buffered event 4 is preserved!

    // Replay delivers event 3
    buffer.processEvent(makeEnvelope(3));

    // Both 3 and preserved 4 are dispatched!
    expect(dispatched.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('stream-4');
  });

  // 12. Timer cleanup and destroy
  it('cleans up active timers and state on clear() and destroy()', () => {
    const onGapTimeout = vi.fn();
    const buffer = new EventSequenceBuffer({
      gapTimeoutMs: 200,
      onGapTimeout,
    });

    buffer.processEvent(makeEnvelope(1));
    buffer.processEvent(makeEnvelope(5));
    expect(buffer.getBufferSize()).toBe(1);

    buffer.destroy();

    expect(buffer.getBufferSize()).toBe(0);
    expect(buffer.getLastProcessedSequence()).toBeNull();
    expect(buffer.getLastDispatchedCheckpoint()).toBeNull();

    // Advance time to verify timer was cancelled
    vi.advanceTimersByTime(500);
    expect(onGapTimeout).not.toHaveBeenCalled();
  });

  // 13. Replay checkpoint correctness
  it('never prematurely advances the replay checkpoint for out-of-order events', () => {
    const buffer = new EventSequenceBuffer();

    buffer.processEvent(makeEnvelope(1, 'cp-1'));
    expect(buffer.getLastDispatchedCheckpoint()).toBe('cp-1');

    buffer.processEvent(makeEnvelope(2, 'cp-2'));
    expect(buffer.getLastDispatchedCheckpoint()).toBe('cp-2');

    // Out-of-order frames 10, 8, 9
    buffer.processEvent(makeEnvelope(10, 'cp-10'));
    buffer.processEvent(makeEnvelope(8, 'cp-8'));
    buffer.processEvent(makeEnvelope(9, 'cp-9'));

    // Checkpoint MUST remain cp-2
    expect(buffer.getLastDispatchedCheckpoint()).toBe('cp-2');
  });

  // 14. Full state reset (sequence 0 / runtime_state_full)
  it('dispatches sequence 0 full state events immediately and resets sequence baseline', () => {
    const dispatched: SseEventEnvelope[] = [];
    const buffer = new EventSequenceBuffer({
      onDispatch: (e) => dispatched.push(e),
    });

    buffer.processEvent(makeEnvelope(1, 's1'));
    buffer.processEvent(makeEnvelope(2, 's2'));
    buffer.processEvent(makeEnvelope(5, 's5')); // Gap

    // Full state arrives
    const fullState = makeEnvelope(0, 'full-1', 'runtime_state_full');
    const res = buffer.processEvent(fullState);

    expect(res.status).toBe('unsequenced');
    expect(buffer.getBufferSize()).toBe(0); // Stale buffer cleared
    expect(buffer.getLastDispatchedCheckpoint()).toBe('full-1');

    // Next sequenced event starts fresh from new baseline
    buffer.processEvent(makeEnvelope(100, 's100'));
    expect(buffer.getLastProcessedSequence()).toBe(100);
    expect(buffer.getLastDispatchedCheckpoint()).toBe('s100');
  });

  // 15. Multi-channel support
  it('tracks sequences independently across distinct channels', () => {
    const dispatched: SseEventEnvelope[] = [];
    const buffer = new EventSequenceBuffer({
      onDispatch: (e) => dispatched.push(e),
    });

    buffer.processEvent(makeEnvelope(1, 'c1-1', 'xp_updated', 'xp_channel'));
    buffer.processEvent(makeEnvelope(1, 'c2-1', 'interview.turn.delta', 'interview_channel'));

    buffer.processEvent(makeEnvelope(2, 'c1-2', 'xp_updated', 'xp_channel'));
    buffer.processEvent(makeEnvelope(2, 'c2-2', 'interview.turn.delta', 'interview_channel'));

    expect(buffer.getLastProcessedSequence('xp_channel')).toBe(2);
    expect(buffer.getLastProcessedSequence('interview_channel')).toBe(2);
    expect(dispatched).toHaveLength(4);
  });
});
