// src/modules/ml/serving/ModelInferenceGateway.ts
// Unified entry point for all ML inference requests.
// Routes to correct model, handles Redis distributed caching, concurrency rate limiting, and circuit breaking.

import { createHash } from 'node:crypto';
import { logger } from '../../../shared/logger.js';
import { getRedisClient } from '../../../shared/redis/client.js';
import type { InferenceRequest, InferenceResult, MLPrediction, InferenceMetrics } from '../types.js';
import { MLServingInfrastructure } from './MLServingInfrastructure.js';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface ModelInferenceGatewayConfig {
  cacheTTLMs?: number;
  maxCacheSize?: number;
  maxConcurrentPerModel?: number;
  maxQueueDepthPerModel?: number;
  circuitBreakerFailureThreshold?: number; // 0.0 - 1.0 (default: 0.5 = 50%)
  circuitBreakerMinRequests?: number;      // minimum requests in rolling window before tripping (default: 5)
  circuitBreakerWindowMs?: number;         // rolling evaluation window (default: 60_000ms)
  circuitBreakerResetTimeoutMs?: number;   // cooldown before transitioning from OPEN to HALF_OPEN (default: 30_000ms)
}

interface CircuitBreakerTracker {
  state: CircuitBreakerState;
  failures: number[];  // timestamps of failures in rolling window
  successes: number[]; // timestamps of successes in rolling window
  openedAt?: number;
  halfOpenInFlight: boolean;
}

interface QueuedInferenceRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * ModelInferenceGateway
 *
 * Unified entry point for all ML inference.
 * Features:
 * - Request routing to correct model
 * - Distributed Redis inference result caching (with in-memory fallback)
 * - Bulkhead concurrency rate limiting per model
 * - Rolling window Circuit Breaker (CLOSED -> OPEN -> HALF_OPEN)
 * - Failover to deterministic fallback
 * - Latency and queue depth telemetry
 */
export class ModelInferenceGateway {
  private serving: MLServingInfrastructure;

  // Caching
  private localCache: Map<string, { result: InferenceResult; timestamp: number }> = new Map();
  private cacheTTLMs: number = 60_000;
  private maxCacheSize: number = 1000;

  // Concurrency Rate Limiter (Bulkhead)
  private maxConcurrentPerModel: number = 10;
  private maxQueueDepthPerModel: number = 50;
  private inFlightRequests: Map<string, number> = new Map();
  private waitQueues: Map<string, QueuedInferenceRequest[]> = new Map();

  // Circuit Breakers per Model
  private circuitBreakers: Map<string, CircuitBreakerTracker> = new Map();
  private circuitFailureThreshold: number = 0.5;
  private circuitMinRequests: number = 5;
  private circuitWindowMs: number = 60_000;
  private circuitResetTimeoutMs: number = 30_000;

  // Metrics
  private totalRequests: number = 0;
  private cacheHits: number = 0;
  private totalLatencyMs: number = 0;
  private errors: number = 0;
  private latencies: number[] = [];

  // Inference handlers
  private handlers: Map<string, (request: InferenceRequest) => Promise<InferenceResult>> = new Map();

  constructor(serving: MLServingInfrastructure, config?: ModelInferenceGatewayConfig) {
    this.serving = serving;
    if (config?.cacheTTLMs !== undefined) this.cacheTTLMs = config.cacheTTLMs;
    if (config?.maxCacheSize !== undefined) this.maxCacheSize = config.maxCacheSize;
    if (config?.maxConcurrentPerModel !== undefined) this.maxConcurrentPerModel = config.maxConcurrentPerModel;
    if (config?.maxQueueDepthPerModel !== undefined) this.maxQueueDepthPerModel = config.maxQueueDepthPerModel;
    if (config?.circuitBreakerFailureThreshold !== undefined) this.circuitFailureThreshold = config.circuitBreakerFailureThreshold;
    if (config?.circuitBreakerMinRequests !== undefined) this.circuitMinRequests = config.circuitBreakerMinRequests;
    if (config?.circuitBreakerWindowMs !== undefined) this.circuitWindowMs = config.circuitBreakerWindowMs;
    if (config?.circuitBreakerResetTimeoutMs !== undefined) this.circuitResetTimeoutMs = config.circuitBreakerResetTimeoutMs;

    logger.info('[ModelInferenceGateway] Initialized with Redis distributed caching, concurrency limiters, and circuit breaking');
  }

  /**
   * Register an inference handler for a model.
   */
  registerHandler(modelId: string, handler: (request: InferenceRequest) => Promise<InferenceResult>): void {
    this.handlers.set(modelId, handler);
    logger.info(`[ModelInferenceGateway] Registered handler for ${modelId}`);
  }

  /**
   * Execute an inference request with caching, circuit breaking, and concurrency guards.
   */
  async infer(request: InferenceRequest): Promise<InferenceResult> {
    const start = Date.now();
    this.totalRequests++;

    // 1. Check distributed Redis & local cache
    if (request.options?.useCache !== false) {
      const cached = await this.checkCache(request);
      if (cached) {
        this.cacheHits++;
        logger.debug(`[ModelInferenceGateway] Cache hit for ${request.modelId}`);
        return { ...cached, cached: true };
      }
    }

    // 2. Check Circuit Breaker state
    if (!this.canAttemptInference(request.modelId)) {
      this.errors++;
      logger.warn(`[ModelInferenceGateway] Circuit breaker is OPEN for model ${request.modelId}, returning immediate fallback`);
      return this.deterministicFallback(request, start);
    }

    // 3. Check model readiness in infrastructure
    if (!this.serving.isModelReady(request.modelId)) {
      logger.warn(`[ModelInferenceGateway] Model ${request.modelId} not ready, using fallback`);
      return this.deterministicFallback(request, start);
    }

    // 4. Validate registered handler
    const handler = this.handlers.get(request.modelId);
    if (!handler) {
      logger.warn(`[ModelInferenceGateway] No handler for ${request.modelId}, using fallback`);
      return this.deterministicFallback(request, start);
    }

    // 5. Acquire concurrency slot (Bulkhead pattern)
    const queueTimeoutMs = Math.min(request.timeout ?? 5000, 2000);
    const slotAcquired = await this.acquireSlot(request.modelId, queueTimeoutMs);
    if (!slotAcquired) {
      this.errors++;
      logger.warn(`[ModelInferenceGateway] Concurrency capacity reached for ${request.modelId}, shedding load to fallback`);
      return this.deterministicFallback(request, start);
    }

    try {
      // Execute with timeout
      const timeoutMs = request.timeout ?? 5000;
      const result = await this.executeWithTimeout(handler, request, timeoutMs);

      // Record successful inference metrics and circuit breaker recovery
      this.serving.recordInference(request.modelId, true);
      this.recordCircuitSuccess(request.modelId);

      const latencyMs = Date.now() - start;
      this.totalLatencyMs += latencyMs;
      this.latencies.push(latencyMs);
      if (this.latencies.length > 1000) this.latencies.shift();

      // Write to distributed Redis cache and local memory
      await this.cacheResult(request, result);

      return result;
    } catch (error) {
      this.errors++;
      this.serving.recordInference(request.modelId, false);
      this.recordCircuitFailure(request.modelId);
      logger.error(`[ModelInferenceGateway] Inference failed for ${request.modelId}`, error);
      return this.deterministicFallback(request, start);
    } finally {
      this.releaseSlot(request.modelId);
    }
  }

  /**
   * Get gateway metrics.
   */
  getMetrics(): InferenceMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p = (pct: number) => sorted[Math.floor(sorted.length * pct / 100)] ?? 0;
    const elapsed = Math.max(1, (Date.now() - (this.latencies[0] ?? Date.now())) / 1000);

    return {
      totalRequests: this.totalRequests,
      averageLatencyMs: this.totalRequests > 0 ? this.totalLatencyMs / this.totalRequests : 0,
      p50LatencyMs: p(50),
      p95LatencyMs: p(95),
      p99LatencyMs: p(99),
      throughputRps: this.totalRequests / elapsed,
      cacheHitRate: this.totalRequests > 0 ? this.cacheHits / this.totalRequests : 0,
      errorRate: this.totalRequests > 0 ? this.errors / this.totalRequests : 0,
      queueDepth: this.getTotalQueueDepth(),
      activeModels: this.handlers.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Concurrency Rate Limiter / Bulkhead
  // ---------------------------------------------------------------------------

  public getInFlightCount(modelId: string): number {
    return this.inFlightRequests.get(modelId) ?? 0;
  }

  public getQueueDepth(modelId?: string): number {
    if (modelId) {
      return this.waitQueues.get(modelId)?.length ?? 0;
    }
    return this.getTotalQueueDepth();
  }

  private getTotalQueueDepth(): number {
    let total = 0;
    for (const queue of this.waitQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  private async acquireSlot(modelId: string, timeoutMs: number): Promise<boolean> {
    const current = this.inFlightRequests.get(modelId) ?? 0;

    if (current < this.maxConcurrentPerModel) {
      this.inFlightRequests.set(modelId, current + 1);
      return true;
    }

    // Capacity reached: check if queuing is allowed
    let queue = this.waitQueues.get(modelId);
    if (!queue) {
      queue = [];
      this.waitQueues.set(modelId, queue);
    }

    if (queue.length >= this.maxQueueDepthPerModel) {
      return false; // Queue full: shed load immediately
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const q = this.waitQueues.get(modelId);
          if (q) {
            const index = q.findIndex((item) => item.timer === timer);
            if (index !== -1) q.splice(index, 1);
          }
          resolve(false);
        }
      }, timeoutMs);

      const queued: QueuedInferenceRequest = {
        resolve: () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(true);
          }
        },
        reject: () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
        },
        timer,
      };

      queue.push(queued);
    });
  }

  private releaseSlot(modelId: string): void {
    const queue = this.waitQueues.get(modelId);
    if (queue && queue.length > 0) {
      const next = queue.shift();
      if (next) {
        next.resolve();
        return;
      }
    }

    const current = this.inFlightRequests.get(modelId) ?? 1;
    const nextVal = Math.max(0, current - 1);
    this.inFlightRequests.set(modelId, nextVal);
  }

  // ---------------------------------------------------------------------------
  // Circuit Breaker State Machine
  // ---------------------------------------------------------------------------

  public getCircuitBreakerState(modelId: string): CircuitBreakerState {
    const tracker = this.circuitBreakers.get(modelId);
    if (!tracker) return 'CLOSED';

    if (tracker.state === 'OPEN') {
      const openedAt = tracker.openedAt ?? 0;
      if (Date.now() - openedAt >= this.circuitResetTimeoutMs) {
        tracker.state = 'HALF_OPEN';
        tracker.halfOpenInFlight = false;
        logger.info(`[ModelInferenceGateway] Circuit breaker transitioned to HALF_OPEN for ${modelId}`);
      }
    }

    return tracker.state;
  }

  public resetCircuitBreaker(modelId: string): void {
    this.circuitBreakers.set(modelId, {
      state: 'CLOSED',
      failures: [],
      successes: [],
      halfOpenInFlight: false,
    });
    logger.info(`[ModelInferenceGateway] Circuit breaker manually reset to CLOSED for ${modelId}`);
  }

  private getOrCreateCircuitTracker(modelId: string): CircuitBreakerTracker {
    let tracker = this.circuitBreakers.get(modelId);
    if (!tracker) {
      tracker = {
        state: 'CLOSED',
        failures: [],
        successes: [],
        halfOpenInFlight: false,
      };
      this.circuitBreakers.set(modelId, tracker);
    }
    return tracker;
  }

  private canAttemptInference(modelId: string): boolean {
    const state = this.getCircuitBreakerState(modelId);
    const tracker = this.getOrCreateCircuitTracker(modelId);

    if (state === 'CLOSED') {
      return true;
    }

    if (state === 'OPEN') {
      return false;
    }

    if (state === 'HALF_OPEN') {
      // Allow only one trial probe at a time in HALF_OPEN
      if (!tracker.halfOpenInFlight) {
        tracker.halfOpenInFlight = true;
        return true;
      }
      return false;
    }

    return true;
  }

  private recordCircuitSuccess(modelId: string): void {
    const tracker = this.getOrCreateCircuitTracker(modelId);
    const now = Date.now();

    if (tracker.state === 'HALF_OPEN') {
      // Trial request succeeded: restore circuit to CLOSED
      tracker.state = 'CLOSED';
      tracker.failures = [];
      tracker.successes = [now];
      tracker.halfOpenInFlight = false;
      logger.info(`[ModelInferenceGateway] Circuit breaker recovered to CLOSED for model ${modelId}`);
      return;
    }

    tracker.successes.push(now);
    this.cleanRollingWindow(tracker, now);
  }

  private recordCircuitFailure(modelId: string): void {
    const tracker = this.getOrCreateCircuitTracker(modelId);
    const now = Date.now();

    if (tracker.state === 'HALF_OPEN') {
      // Trial probe failed: trip immediately back to OPEN
      tracker.state = 'OPEN';
      tracker.openedAt = now;
      tracker.halfOpenInFlight = false;
      logger.warn(`[ModelInferenceGateway] Circuit breaker trial probe failed for model ${modelId}, re-opening circuit`);
      return;
    }

    tracker.failures.push(now);
    this.cleanRollingWindow(tracker, now);

    const total = tracker.failures.length + tracker.successes.length;
    if (total >= this.circuitMinRequests) {
      const failureRate = tracker.failures.length / total;
      if (failureRate >= this.circuitFailureThreshold) {
        tracker.state = 'OPEN';
        tracker.openedAt = now;
        logger.warn(
          `[ModelInferenceGateway] Circuit breaker TRIPPED to OPEN for model ${modelId} ` +
          `(failure rate: ${(failureRate * 100).toFixed(1)}% across ${total} requests)`
        );
      }
    }
  }

  private cleanRollingWindow(tracker: CircuitBreakerTracker, now: number): void {
    const cutoff = now - this.circuitWindowMs;
    tracker.failures = tracker.failures.filter((t) => t >= cutoff);
    tracker.successes = tracker.successes.filter((t) => t >= cutoff);
  }

  // ---------------------------------------------------------------------------
  // Distributed Redis & Local Memory Caching
  // ---------------------------------------------------------------------------

  private cacheKey(request: InferenceRequest): string {
    const inputStr = JSON.stringify(request.input ?? {});
    const hash = createHash('sha256').update(inputStr).digest('hex').slice(0, 16);
    return `ml:inference:${request.modelId}:${hash}`;
  }

  private async checkCache(request: InferenceRequest): Promise<InferenceResult | null> {
    const key = this.cacheKey(request);

    // 1. Check Redis distributed cache
    try {
      const redis = getRedisClient();
      if (redis && (redis.status === 'ready' || redis.status === 'connecting')) {
        const cachedStr = await redis.get(key);
        if (cachedStr) {
          const result = JSON.parse(cachedStr) as InferenceResult;
          // Synchronize local memory cache
          this.localCache.set(key, { result, timestamp: Date.now() });
          return result;
        }
      }
    } catch (err) {
      logger.warn('[ModelInferenceGateway] Redis cache read failed, falling back to local memory', { error: err });
    }

    // 2. Check local memory cache
    const entry = this.localCache.get(key);
    if (entry && Date.now() - entry.timestamp < this.cacheTTLMs) {
      return entry.result;
    }
    if (entry) this.localCache.delete(key);

    return null;
  }

  private async cacheResult(request: InferenceRequest, result: InferenceResult): Promise<void> {
    const key = this.cacheKey(request);
    const ttlSeconds = Math.max(1, Math.floor(this.cacheTTLMs / 1000));

    // 1. Write to Redis distributed cache
    try {
      const redis = getRedisClient();
      if (redis && (redis.status === 'ready' || redis.status === 'connecting')) {
        await redis.set(key, JSON.stringify(result), 'EX', ttlSeconds);
      }
    } catch (err) {
      logger.warn('[ModelInferenceGateway] Redis cache write failed', { error: err });
    }

    // 2. Write to local in-memory cache
    if (this.localCache.size >= this.maxCacheSize) {
      const firstKey = this.localCache.keys().next().value;
      if (firstKey) this.localCache.delete(firstKey);
    }
    this.localCache.set(key, { result, timestamp: Date.now() });
  }

  // ---------------------------------------------------------------------------
  // Execution & Fallbacks
  // ---------------------------------------------------------------------------

  private async executeWithTimeout(
    handler: (request: InferenceRequest) => Promise<InferenceResult>,
    request: InferenceRequest,
    timeoutMs: number,
  ): Promise<InferenceResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Inference timeout after ${timeoutMs}ms`)), timeoutMs);
      handler(request)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private deterministicFallback(request: InferenceRequest, startTime: number): InferenceResult {
    logger.info(`[ModelInferenceGateway] Deterministic fallback for ${request.modelId}`);
    return {
      requestId: request.requestId,
      modelId: request.modelId,
      prediction: {
        score: 0.5,
        confidence: 0.3, // Low confidence for fallback
        uncertainty: 0.7,
        semanticCertainty: 0.2,
        evidenceCoverage: 0.1,
        retrievalStability: 0.5,
        featureImportance: [],
        modelId: `${request.modelId}-fallback`,
        modelVersion: 'deterministic',
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      } as MLPrediction,
      cached: false,
      latencyMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }
}
