import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const redis = {
  incr: vi.fn(async () => 7),
  expire: vi.fn(async () => 1),
  xtrim: vi.fn(async () => 0),
  xadd: vi.fn(async () => '1700000000000-0'),
  publish: vi.fn(async () => 1),
};

vi.mock('../../shared/redis/client.js', () => ({
  getRedisClient: () => redis,
  getRedisHealth: () => ({ status: 'connected' }),
  isRedisConfigured: () => false,
  createRedisConnection: vi.fn(),
}));

import { EventBus, type SseClient } from '../../shared/sse/eventBus.js';

// The same schemas the studio UI applies in frontend/src/features/interview/hooks/useInterviewSession.ts.
const uiDeltaSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number().int().min(0).max(4),
  stateVersion: z.number().int().nonnegative(),
  delta: z.string(),
  seq: z.number().int().nonnegative(),
});
const uiCompletedSchema = z.object({ sessionId: z.string() });

const decoder = new TextDecoder();

function connect(bus: EventBus, userId: string, clientId = `${userId}-client`) {
  const frames: string[] = [];
  const client: SseClient = {
    id: clientId,
    userId,
    connectedAt: Date.now(),
    controller: { enqueue: (chunk: Uint8Array) => frames.push(decoder.decode(chunk)) } as unknown as ReadableStreamDefaultController<Uint8Array>,
    emit: () => undefined,
    destroy: () => undefined,
  };
  bus.register(client);
  return frames;
}

/** Parse the `id:` and `data:` lines of one SSE frame. */
function parseFrame(frame: string) {
  const id = /^id: (.*)$/m.exec(frame)?.[1];
  const data = JSON.parse(/^data: (.*)$/m.exec(frame)![1]!);
  return { id, data };
}

let bus: EventBus;
beforeEach(() => {
  vi.clearAllMocks();
  bus = new EventBus();
});
afterEach(() => bus.shutdown());

describe('interview.time_warning', () => {
  it('delivers the five-minute warning only to the session owner', async () => {
    const owner = connect(bus, 'owner');
    const other = connect(bus, 'other');
    await bus.publishEnvelope('owner', 'interview.time_warning', { sessionId: 's1', minutesRemaining: 5 });
    expect(other).toHaveLength(0);
    expect(owner).toHaveLength(1);
    expect(parseFrame(owner[0]).data).toMatchObject({
      type: 'interview.time_warning', userId: 'owner', payload: { sessionId: 's1', minutesRemaining: 5 },
    });
  });
});

describe('interview.turn.delta', () => {
  const payload = { sessionId: 's1', turnIndex: 2, stateVersion: 9, delta: 'Nice ', seq: 0 };

  it('reaches only the owner, in the shape the studio UI parses', () => {
    const owner = connect(bus, 'user-a');
    const other = connect(bus, 'user-b');

    bus.emitInterviewTurnDelta('user-a', payload);

    expect(other).toHaveLength(0);
    expect(owner).toHaveLength(1);
    const { data } = parseFrame(owner[0]!);
    expect(data).toMatchObject({ type: 'interview.turn.delta', userId: 'user-a' });
    expect(uiDeltaSchema.parse(data.payload)).toEqual(payload);
  });

  it('is sent without an SSE id and does not touch the Redis replay stream', () => {
    const frames = connect(bus, 'user-a');

    bus.emitInterviewTurnDelta('user-a', payload);
    bus.emitInterviewTurnDelta('user-a', { ...payload, delta: 'work', seq: 1 });

    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame).not.toMatch(/^id:/m);
      expect(parseFrame(frame).data).not.toHaveProperty('sequence');
    }
    expect(redis.incr).not.toHaveBeenCalled();
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('keeps deltas distinguishable for a client that de-duplicates on type, time and payload', () => {
    const frames = connect(bus, 'user-a');
    bus.emitInterviewTurnDelta('user-a', { ...payload, delta: 'ha', seq: 0 });
    bus.emitInterviewTurnDelta('user-a', { ...payload, delta: 'ha', seq: 1 });

    const seqs = frames.map(frame => parseFrame(frame).data.payload.seq);
    expect(seqs).toEqual([0, 1]);
  });
});

describe('interview.session.completed', () => {
  it('is a replayable envelope: stored in the Redis stream and delivered with its stream id', async () => {
    const frames = connect(bus, 'user-a');

    await bus.emitInterviewSessionCompleted('user-a', { sessionId: 's1', mode: 'basic_mode' });

    expect(redis.xadd).toHaveBeenCalledWith(
      'sse:stream:user-a', '*', 'type', 'interview.session.completed', 'sequence', '7',
      'payload', JSON.stringify({ sessionId: 's1', mode: 'basic_mode' }), 'timestamp', expect.any(String),
      'correlationId', expect.any(String), 'schemaVersion', '1',
    );
    expect(frames).toHaveLength(1);
    const { id, data } = parseFrame(frames[0]!);
    expect(id).toBe('1700000000000-0');
    expect(data.type).toBe('interview.session.completed');
    expect(uiCompletedSchema.parse(data.payload)).toEqual({ sessionId: 's1' });
  });
});
