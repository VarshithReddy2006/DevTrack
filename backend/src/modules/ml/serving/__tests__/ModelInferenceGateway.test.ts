import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelInferenceGateway } from '../ModelInferenceGateway.js';
import { MLServingInfrastructure } from '../MLServingInfrastructure.js';
import type { InferenceRequest, InferenceResult, MLPrediction } from '../../types.js';

// Mock Redis client
const mockRedisStore = new Map<string, string>();
const mockRedisClient = {
  status: 'ready',
  get: vi.fn(async (key: string) => mockRedisStore.get(key) ?? null),
  set: vi.fn(async (key: string, val: string) => {
    mockRedisStore.set(key, val);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => {
    mockRedisStore.delete(key);
    return 1;
  }),
};

vi.mock('../../../../shared/redis/client.js', () => ({
  getRedisClient: () => mockRedisClient,
  isRedisConfigured: () => true,
}));

describe('ModelInferenceGateway - Distributed Caching, Bulkhead Concurrency & Circuit Breaking', () => {
  let servingMock: MLServingInfrastructure;
  let gateway: ModelInferenceGateway;

  beforeEach(() => {
    mockRedisStore.clear();
    vi.clearAllMocks();

    servingMock = {
      isModelReady: vi.fn().mockReturnValue(true),
      recordInference: vi.fn(),
    } as unknown as MLServingInfrastructure;

    gateway = new ModelInferenceGateway(servingMock, {
      cacheTTLMs: 10_000,
      maxConcurrentPerModel: 2,
      maxQueueDepthPerModel: 2,
      circuitBreakerFailureThreshold: 0.5,
      circuitBreakerMinRequests: 4,
      circuitBreakerWindowMs: 10_000,
      circuitBreakerResetTimeoutMs: 100,
    });
  });

  const makeRequest = (modelId = 'distilbert-ats', input: any = 'test candidate resume'): InferenceRequest => ({
    requestId: `req-${Math.random().toString(36).substring(2, 9)}`,
    modelId,
    input,
    priority: 'normal',
    timeout: 1000,
  });

  const mockPrediction = (score = 0.9): MLPrediction => ({
    score,
    confidence: 0.95,
    uncertainty: 0.05,
    semanticCertainty: 0.9,
    evidenceCoverage: 0.85,
    retrievalStability: 0.88,
    featureImportance: [],
    modelId: 'distilbert-ats',
    modelVersion: '1.0.0',
    latencyMs: 15,
    timestamp: new Date().toISOString(),
  });

  describe('Distributed Redis Caching', () => {
    it('executes handler on cache miss and populates Redis cache', async () => {
      const handler = vi.fn().mockResolvedValue({
        requestId: 'req-1',
        modelId: 'distilbert-ats',
        prediction: mockPrediction(0.85),
        cached: false,
        latencyMs: 10,
        timestamp: new Date().toISOString(),
      });

      gateway.registerHandler('distilbert-ats', handler);

      const req = makeRequest('distilbert-ats', { resumeId: 'res-123' });
      const result = await gateway.infer(req);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(result.cached).toBe(false);
      expect(mockRedisClient.set).toHaveBeenCalledTimes(1);

      // Verify cached in Redis store
      const keys = Array.from(mockRedisStore.keys());
      expect(keys.some((k) => k.startsWith('ml:inference:distilbert-ats:'))).toBe(true);
    });

    it('returns cached prediction from Redis on subsequent identical request', async () => {
      const handler = vi.fn().mockResolvedValue({
        requestId: 'req-1',
        modelId: 'distilbert-ats',
        prediction: mockPrediction(0.92),
        cached: false,
        latencyMs: 12,
        timestamp: new Date().toISOString(),
      });

      gateway.registerHandler('distilbert-ats', handler);

      const req = makeRequest('distilbert-ats', { resumeId: 'res-shared' });

      // First call: cache miss
      const firstResult = await gateway.infer(req);
      expect(firstResult.cached).toBe(false);
      expect(handler).toHaveBeenCalledTimes(1);

      // Second call: Redis cache hit
      const secondResult = await gateway.infer(req);
      expect(secondResult.cached).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1); // handler NOT called again
      expect((secondResult.prediction as MLPrediction).score).toBe(0.92);

      const metrics = gateway.getMetrics();
      expect(metrics.cacheHitRate).toBe(0.5);
    });

    it('bypasses cache when request options specify useCache: false', async () => {
      const handler = vi.fn().mockResolvedValue({
        requestId: 'req-1',
        modelId: 'distilbert-ats',
        prediction: mockPrediction(0.88),
        cached: false,
        latencyMs: 10,
        timestamp: new Date().toISOString(),
      });

      gateway.registerHandler('distilbert-ats', handler);

      const reqWithBypass: InferenceRequest = {
        ...makeRequest('distilbert-ats', { resumeId: 'res-bypass' }),
        options: { useCache: false },
      };

      await gateway.infer(reqWithBypass);
      await gateway.infer(reqWithBypass);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('falls back to local memory cache if Redis encounters read failure', async () => {
      const handler = vi.fn().mockResolvedValue({
        requestId: 'req-1',
        modelId: 'distilbert-ats',
        prediction: mockPrediction(0.77),
        cached: false,
        latencyMs: 10,
        timestamp: new Date().toISOString(),
      });

      gateway.registerHandler('distilbert-ats', handler);
      const req = makeRequest('distilbert-ats', { resumeId: 'res-redis-fail' });

      // First run fills both Redis and local cache
      await gateway.infer(req);
      expect(handler).toHaveBeenCalledTimes(1);

      // Simulate Redis read error
      mockRedisClient.get.mockRejectedValueOnce(new Error('Redis connection reset'));

      // Second run should gracefully recover from local in-memory cache
      const cachedResult = await gateway.infer(req);
      expect(cachedResult.cached).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('Bulkhead Concurrency Rate Limiter', () => {
    it('allows concurrent requests up to maxConcurrentPerModel', async () => {
      let activeCount = 0;
      let maxSeenActive = 0;

      const handler = vi.fn().mockImplementation(async (request: InferenceRequest) => {
        activeCount++;
        maxSeenActive = Math.max(maxSeenActive, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 50));
        activeCount--;
        return {
          requestId: request.requestId,
          modelId: request.modelId,
          prediction: mockPrediction(0.8),
          cached: false,
          latencyMs: 50,
          timestamp: new Date().toISOString(),
        };
      });

      gateway.registerHandler('distilbert-ats', handler);

      const req1 = makeRequest('distilbert-ats', { id: 1 });
      const req2 = makeRequest('distilbert-ats', { id: 2 });

      await Promise.all([gateway.infer(req1), gateway.infer(req2)]);

      expect(maxSeenActive).toBe(2);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('queues concurrent requests when capacity is exceeded and executes them upon slot release', async () => {
      const executionOrder: number[] = [];

      const handler = vi.fn().mockImplementation(async (request: InferenceRequest) => {
        const id = Number(request.input);
        executionOrder.push(id);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          requestId: request.requestId,
          modelId: request.modelId,
          prediction: mockPrediction(0.8),
          cached: false,
          latencyMs: 40,
          timestamp: new Date().toISOString(),
        };
      });

      gateway.registerHandler('distilbert-ats', handler);

      // Launch 3 requests (maxConcurrent is 2, so 3rd will queue)
      const p1 = gateway.infer(makeRequest('distilbert-ats', '1'));
      const p2 = gateway.infer(makeRequest('distilbert-ats', '2'));
      const p3 = gateway.infer(makeRequest('distilbert-ats', '3'));

      const results = await Promise.all([p1, p2, p3]);

      expect(results).toHaveLength(3);
      expect(executionOrder).toContain(1);
      expect(executionOrder).toContain(2);
      expect(executionOrder).toContain(3);
      expect(gateway.getInFlightCount('distilbert-ats')).toBe(0);
      expect(gateway.getQueueDepth('distilbert-ats')).toBe(0);
    });

    it('sheds load to deterministic fallback when queue is full', async () => {
      // Gateway is configured with maxConcurrent = 2, maxQueueDepth = 2
      // Launching 5 requests will saturate slots (2) + queue (2) + 1 shed to fallback
      const handler = vi.fn().mockImplementation(async (request: InferenceRequest) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          requestId: request.requestId,
          modelId: request.modelId,
          prediction: mockPrediction(0.8),
          cached: false,
          latencyMs: 100,
          timestamp: new Date().toISOString(),
        };
      });

      gateway.registerHandler('distilbert-ats', handler);

      const requests = Array.from({ length: 5 }, (_, i) =>
        gateway.infer(makeRequest('distilbert-ats', { id: `overflow-${i}` }))
      );

      const results = await Promise.all(requests);

      // At least 1 request was shed to deterministic fallback
      const fallbacks = results.filter((r) => r?.prediction?.modelVersion === 'deterministic');
      expect(fallbacks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Circuit Breaker Pattern', () => {
    it('starts in CLOSED state and remains CLOSED under successful inferences', async () => {
      const handler = vi.fn().mockResolvedValue({
        requestId: 'req-ok',
        modelId: 'distilbert-ats',
        prediction: mockPrediction(0.9),
        cached: false,
        latencyMs: 10,
        timestamp: new Date().toISOString(),
      });

      gateway.registerHandler('distilbert-ats', handler);

      for (let i = 0; i < 5; i++) {
        await gateway.infer(makeRequest('distilbert-ats', { i }));
      }

      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('CLOSED');
    });

    it('trips from CLOSED to OPEN when failure rate exceeds threshold', async () => {
      // circuitBreakerMinRequests = 4, threshold = 0.5
      const failingHandler = vi.fn().mockRejectedValue(new Error('Model backend crash'));
      gateway.registerHandler('distilbert-ats', failingHandler);

      // Trigger 4 failed requests
      for (let i = 0; i < 4; i++) {
        const res = await gateway.infer(makeRequest('distilbert-ats', { failId: i }));
        expect(res.prediction.modelVersion).toBe('deterministic');
      }

      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('OPEN');

      // Subsequent request in OPEN state should fast-fail to fallback without even calling handler
      failingHandler.mockClear();
      const openResult = await gateway.infer(makeRequest('distilbert-ats', { failId: 99 }));
      expect(openResult.prediction.modelVersion).toBe('deterministic');
      expect(failingHandler).not.toHaveBeenCalled();
    });

    it('transitions to HALF_OPEN after reset timeout and recovers to CLOSED on success', async () => {
      // 1. Trip circuit to OPEN
      const handler = vi.fn().mockRejectedValue(new Error('Timeout'));
      gateway.registerHandler('distilbert-ats', handler);

      for (let i = 0; i < 4; i++) {
        await gateway.infer(makeRequest('distilbert-ats', { failId: i }));
      }
      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('OPEN');

      // 2. Wait for reset timeout (configured as 100ms in test)
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('HALF_OPEN');

      // 3. Next trial request succeeds
      handler.mockResolvedValueOnce({
        requestId: 'req-recovered',
        modelId: 'distilbert-ats',
        prediction: mockPrediction(0.95),
        cached: false,
        latencyMs: 15,
        timestamp: new Date().toISOString(),
      });

      const recoveredResult = await gateway.infer(makeRequest('distilbert-ats', 'trial-input'));
      expect(recoveredResult.cached).toBe(false);
      expect((recoveredResult.prediction as MLPrediction).score).toBe(0.95);

      // 4. Circuit breaker should now be restored to CLOSED
      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('CLOSED');
    });

    it('transitions back to OPEN if trial probe in HALF_OPEN fails', async () => {
      // 1. Trip circuit
      const handler = vi.fn().mockRejectedValue(new Error('Error'));
      gateway.registerHandler('distilbert-ats', handler);

      for (let i = 0; i < 4; i++) {
        await gateway.infer(makeRequest('distilbert-ats', { failId: i }));
      }
      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('OPEN');

      // 2. Wait for reset timeout
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('HALF_OPEN');

      // 3. Trial probe fails again
      handler.mockRejectedValueOnce(new Error('Still down'));
      await gateway.infer(makeRequest('distilbert-ats', { trial: 2 }));

      // 4. Circuit should immediately trip back to OPEN
      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('OPEN');
    });

    it('supports manual circuit reset', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Error'));
      gateway.registerHandler('distilbert-ats', handler);

      for (let i = 0; i < 4; i++) {
        await gateway.infer(makeRequest('distilbert-ats', { failId: i }));
      }
      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('OPEN');

      gateway.resetCircuitBreaker('distilbert-ats');
      expect(gateway.getCircuitBreakerState('distilbert-ats')).toBe('CLOSED');
    });
  });

  describe('Model Fallback & Readiness', () => {
    it('returns deterministic fallback if model is not ready in serving infrastructure', async () => {
      (servingMock.isModelReady as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const res = await gateway.infer(makeRequest('unready-model'));
      expect(res.prediction.modelVersion).toBe('deterministic');
      expect((res.prediction as MLPrediction).confidence).toBe(0.3);
    });

    it('returns deterministic fallback if no handler is registered', async () => {
      const res = await gateway.infer(makeRequest('unregistered-model'));
      expect(res.prediction.modelVersion).toBe('deterministic');
    });
  });
});
