import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferencePriority, InferenceRequest, InferenceResult } from '../types.js';
import { InferenceQueueManager } from './InferenceQueueManager.js';

function request(requestId: string, priority: InferencePriority = 'normal', timeout = 1_000): InferenceRequest {
  return { requestId, priority, timeout, modelId: 'model', input: 'input' };
}

function result(item: InferenceRequest): InferenceResult {
  return {
    requestId: item.requestId,
    modelId: item.modelId,
    prediction: {
      label: 'match',
      probability: 1,
      confidence: 1,
      allLabels: [{ label: 'match', probability: 1 }],
      modelId: item.modelId,
      modelVersion: '1',
      latencyMs: 0,
      timestamp: new Date().toISOString(),
    },
    cached: false,
    latencyMs: 0,
    timestamp: new Date().toISOString(),
  };
}

function pendingBatch() {
  let resolve!: (results: InferenceResult[]) => void;
  const promise = new Promise<InferenceResult[]>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('InferenceQueueManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears the request timeout immediately when processing starts', async () => {
    const queue = new InferenceQueueManager();
    queue.setProcessor(async requests => {
      expect(vi.getTimerCount()).toBe(0);
      return requests.map(result);
    });

    await expect(queue.enqueue(request('fast'))).resolves.toMatchObject({ requestId: 'fast' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('processes queued work by priority and preserves FIFO within a priority', async () => {
    const queue = new InferenceQueueManager({ batchSize: 2, processIntervalMs: 10 });
    const processor = vi.fn(async (requests: InferenceRequest[]) => requests.map(result));
    const pending = [
      queue.enqueue(request('low', 'low')),
      queue.enqueue(request('high-first', 'high')),
      queue.enqueue(request('normal')),
      queue.enqueue(request('high-second', 'high')),
      queue.enqueue(request('critical', 'critical')),
    ];

    queue.setProcessor(processor);
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all(pending);

    expect(processor.mock.calls.flatMap(([batch]) => batch.map(item => item.requestId)))
      .toEqual(['critical', 'high-first', 'high-second', 'normal', 'low']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects overflow and expires only the queued entry whose deadline passed', async () => {
    const queue = new InferenceQueueManager({ maxQueueDepth: 2 });
    const surviving = request('same-id');
    const pending = queue.enqueue(surviving);
    const expired = expect(queue.enqueue(request('same-id', 'normal', 10))).rejects.toThrow('timed out');
    await expect(queue.enqueue(request('overflow'))).rejects.toThrow('backpressure');

    await vi.advanceTimersByTimeAsync(10);
    await expired;

    const processor = vi.fn(async (requests: InferenceRequest[]) => requests.map(result));
    queue.setProcessor(processor);
    await pending;
    expect(processor).toHaveBeenCalledExactlyOnceWith([surviving]);
    expect(queue.getMetrics()).toMatchObject({ totalDropped: 1, totalTimeouts: 1, totalProcessed: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a failed batch and continues processing during graceful shutdown', async () => {
    const queue = new InferenceQueueManager({ batchSize: 2, processIntervalMs: 10 });
    const first = expect(queue.enqueue(request('first'))).rejects.toThrow('processor failed');
    const second = expect(queue.enqueue(request('second'))).rejects.toThrow('processor failed');
    const third = queue.enqueue(request('third'));
    const processor = vi.fn(async (requests: InferenceRequest[]) => requests.map(result))
      .mockRejectedValueOnce(new Error('processor failed'));

    queue.setProcessor(processor);
    const shutdown = queue.shutdown();
    expect(queue.shutdown()).toBe(shutdown);
    await expect(queue.enqueue(request('late'))).rejects.toThrow('shutting down');

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([first, second, third, shutdown]);
    expect(processor).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a drain wait without interrupting active work or closing the queue', async () => {
    const queue = new InferenceQueueManager();
    const active = request('active');
    const batch = pendingBatch();
    queue.setProcessor(() => batch.promise);

    const running = queue.enqueue(active);
    const draining = queue.drain();
    const timedDrain = expect(queue.drain(10)).rejects.toThrow('drain timed out');

    await vi.advanceTimersByTimeAsync(10);
    await timedDrain;
    batch.resolve([result(active)]);
    await Promise.all([running, draining]);

    queue.setProcessor(async requests => requests.map(result));
    await expect(queue.enqueue(request('next'))).resolves.toMatchObject({ requestId: 'next' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects active and pending requests when shutdown reaches its deadline', async () => {
    const queue = new InferenceQueueManager({ batchSize: 1 });
    const active = request('active');
    const batch = pendingBatch();
    const processor = vi.fn(() => batch.promise);
    queue.setProcessor(processor);

    const running = expect(queue.enqueue(active)).rejects.toThrow('drain timed out');
    const pending = expect(queue.enqueue(request('pending'))).rejects.toThrow('drain timed out');
    const shutdown = queue.shutdown(10);

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all([running, pending, shutdown]);
    batch.resolve([result(active)]);
    await Promise.resolve();
    expect(processor).toHaveBeenCalledTimes(1);
    expect(queue.getMetrics()).toMatchObject({ queueDepth: 0, totalProcessed: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
