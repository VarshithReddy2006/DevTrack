// src/modules/ml/inference/MLInferenceRuntime.ts
// Production-grade ML inference runtime with batching, queuing, async execution,
// timeout/retry handling, degraded-mode inference, and provider fallback.

import { logger } from '../../../shared/logger.js';
import type { InferenceRequest, InferenceResult, InferenceMetrics, MLPrediction } from '../types.js';
import type { MLGovernanceLayer } from '../governance/MLGovernanceLayer.js';
import type { ModelRegistryEngine } from '../registry/ModelRegistryEngine.js';

interface InferenceGovernance {
  governance?: Pick<MLGovernanceLayer, 'isModelBlocked' | 'evaluatePrediction'>;
  registry?: Pick<ModelRegistryEngine, 'getModel' | 'rollback'>;
}

interface RuntimeConfig {
  maxBatchSize: number;
  batchTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  maxConcurrentInferences: number;
  degradedModeThreshold: number;    // error rate threshold for degraded mode
  circuitBreakerThreshold: number;  // error count to trip circuit breaker
  circuitBreakerResetMs: number;
}

interface InferenceProvider {
  name: string;
  priority: number;
  execute: (request: InferenceRequest) => Promise<InferenceResult>;
  isHealthy: () => boolean;
}

/**
 * MLInferenceRuntime
 *
 * Production ML inference runtime supporting:
 * - Request batching for throughput
 * - Async execution with concurrency limits
 * - Timeout + retry handling
 * - Degraded-mode inference (simplified models)
 * - Provider fallback chain
 * - Circuit breaker pattern
 * - Comprehensive metrics tracking
 */
export class MLInferenceRuntime {
  private config: RuntimeConfig;
  private providers: InferenceProvider[] = [];

  // Metrics
  private metrics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    timeoutRequests: number;
    retryRequests: number;
    degradedRequests: number;
    fallbackRequests: number;
    latencies: number[];
    batchSizes: number[];
  } = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    timeoutRequests: 0,
    retryRequests: 0,
    degradedRequests: 0,
    fallbackRequests: 0,
    latencies: [],
    batchSizes: [],
  };

  // Circuit breaker
  private circuitBreaker: {
    isOpen: boolean;
    failureCount: number;
    lastFailureTime: number;
    openedAt: number | null;
  } = {
    isOpen: false,
    failureCount: 0,
    lastFailureTime: 0,
    openedAt: null,
  };

  // Active inferences
  private activeInferences: number = 0;

  // Batch accumulator
  private pendingBatch: {
    request: InferenceRequest;
    resolve: (result: InferenceResult) => void;
    reject: (error: Error) => void;
  }[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config?: Partial<RuntimeConfig>, private readonly controls: InferenceGovernance = {}) {
    this.config = {
      maxBatchSize: config?.maxBatchSize ?? 16,
      batchTimeoutMs: config?.batchTimeoutMs ?? 50,
      maxRetries: config?.maxRetries ?? 2,
      retryDelayMs: config?.retryDelayMs ?? 100,
      maxConcurrentInferences: config?.maxConcurrentInferences ?? 10,
      degradedModeThreshold: config?.degradedModeThreshold ?? 0.3,
      circuitBreakerThreshold: config?.circuitBreakerThreshold ?? 10,
      circuitBreakerResetMs: config?.circuitBreakerResetMs ?? 30000,
    };
    logger.info('[MLInferenceRuntime] Initialized', { config: this.config });
  }

  /**
   * Register an inference provider.
   */
  registerProvider(provider: InferenceProvider): void {
    this.providers.push(provider);
    this.providers.sort((a, b) => a.priority - b.priority);
    logger.info(`[MLInferenceRuntime] Registered provider: ${provider.name} (priority ${provider.priority})`);
  }

  /**
   * Execute a single inference request with retry and fallback.
   */
  async infer(request: InferenceRequest): Promise<InferenceResult> {
    this.metrics.totalRequests++;
    const start = Date.now();

    // Circuit breaker check
    if (this.isCircuitOpen()) {
      logger.warn('[MLInferenceRuntime] Circuit breaker open, using degraded mode');
      return this.degradedModeInference(request, start);
    }

    // Concurrency check
    if (this.activeInferences >= this.config.maxConcurrentInferences) {
      logger.warn('[MLInferenceRuntime] Max concurrency reached, queuing');
      return this.degradedModeInference(request, start);
    }

    this.activeInferences++;

    try {
      const result = await this.executeWithRetry(request);
      if (!result) return this.degradedModeInference(request, start);
      this.metrics.successfulRequests++;
      this.circuitBreaker.failureCount = 0;
      const latency = Date.now() - start;
      this.trackLatency(latency);
      return result;
    } catch (error) {
      this.metrics.failedRequests++;
      this.circuitBreaker.failureCount++;
      this.circuitBreaker.lastFailureTime = Date.now();

      // Check circuit breaker
      if (this.circuitBreaker.failureCount >= this.config.circuitBreakerThreshold) {
        this.tripCircuitBreaker();
      }

      logger.error('[MLInferenceRuntime] All providers failed', error);
      return this.degradedModeInference(request, start);
    } finally {
      this.activeInferences--;
    }
  }

  /**
   * Batch inference: accumulate requests and execute together.
   */
  async inferBatch(request: InferenceRequest): Promise<InferenceResult> {
    return new Promise<InferenceResult>((resolve, reject) => {
      this.pendingBatch.push({ request, resolve, reject });

      if (this.pendingBatch.length >= this.config.maxBatchSize) {
        this.flushBatch();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flushBatch(), this.config.batchTimeoutMs);
      }
    });
  }

  /**
   * Get comprehensive inference metrics.
   */
  getMetrics(): InferenceMetrics {
    const latencies = [...this.metrics.latencies].sort((a, b) => a - b);
    const p = (pct: number) => latencies[Math.floor(latencies.length * pct / 100)] ?? 0;
    const total = this.metrics.totalRequests || 1;

    return {
      totalRequests: this.metrics.totalRequests,
      averageLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      p50LatencyMs: p(50),
      p95LatencyMs: p(95),
      p99LatencyMs: p(99),
      throughputRps: this.metrics.totalRequests / Math.max(1, (Date.now() - (this.metrics.latencies[0] ?? Date.now())) / 1000),
      cacheHitRate: 0,
      errorRate: this.metrics.failedRequests / total,
      queueDepth: this.pendingBatch.length,
      activeModels: this.providers.length,
    };
  }

  /**
   * Get detailed runtime status.
   */
  getStatus(): {
    healthy: boolean;
    circuitBreakerOpen: boolean;
    degradedMode: boolean;
    activeInferences: number;
    pendingBatch: number;
    providers: { name: string; healthy: boolean }[];
  } {
    const errorRate = this.metrics.totalRequests > 0
      ? this.metrics.failedRequests / this.metrics.totalRequests
      : 0;

    return {
      healthy: !this.circuitBreaker.isOpen && errorRate < this.config.degradedModeThreshold,
      circuitBreakerOpen: this.circuitBreaker.isOpen,
      degradedMode: errorRate >= this.config.degradedModeThreshold,
      activeInferences: this.activeInferences,
      pendingBatch: this.pendingBatch.length,
      providers: this.providers.map(p => ({ name: p.name, healthy: p.isHealthy() })),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async executeWithRetry(request: InferenceRequest): Promise<InferenceResult | null> {
    let lastError: Error | null = null;

    // Try each provider in priority order
    for (const provider of this.providers) {
      if (!provider.isHealthy()) continue;

      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        if (!(await this.canServe(request.modelId))) return null;
        let result: InferenceResult;
        try {
          result = await this.executeWithTimeout(provider, request);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt < this.config.maxRetries) {
            this.metrics.retryRequests++;
            await this.sleep(this.config.retryDelayMs * (attempt + 1));
          }
          continue;
        }
        return (await this.canServe(request.modelId, result)) ? result : null;
      }
    }

    throw lastError ?? new Error('No providers available');
  }

  private async canServe(modelId: string, result?: InferenceResult): Promise<boolean> {
    const { registry, governance } = this.controls;
    if (!registry && !governance) return true;

    try {
      const prediction = result?.prediction;
      if (result && (result.modelId !== modelId || prediction?.modelId !== modelId)) return false;

      if (registry) {
        const model = await registry.getModel(modelId);
        if (!model?.evaluationGate.passed || model.driftStatus === 'critical' ||
            (model.deploymentState !== 'production' && model.deploymentState !== 'canary') ||
            (prediction && prediction.modelVersion !== model.version)) {
          return false;
        }
      }

      if (!governance) return true;
      if (!prediction) return !(await governance.isModelBlocked(modelId));

      const confidence = 'confidence' in prediction
        ? prediction.confidence
        : prediction.items.reduce(
          (minimum, item) => Math.min(minimum, item.confidence),
          prediction.items.length > 0 ? 1 : 0,
        );
      const decision = await governance.evaluatePrediction({ modelId, confidence, latencyMs: prediction.latencyMs });
      if (decision.action === 'rollback') await registry?.rollback(modelId, 'Inference governance policy violation');
      return decision.allowed;
    } catch (error) {
      logger.warn('[MLInferenceRuntime] Governance check failed, using degraded mode', { modelId, error });
      return false;
    }
  }

  private async executeWithTimeout(
    provider: InferenceProvider,
    request: InferenceRequest,
  ): Promise<InferenceResult> {
    return new Promise<InferenceResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.metrics.timeoutRequests++;
        reject(new Error(`Timeout after ${request.timeout}ms`));
      }, request.timeout);

      provider.execute(request)
        .then(result => { clearTimeout(timer); resolve(result); })
        .catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  private degradedModeInference(request: InferenceRequest, startTime: number): InferenceResult {
    this.metrics.degradedRequests++;
    logger.info(`[MLInferenceRuntime] Degraded mode inference for ${request.modelId}`);

    return {
      requestId: request.requestId,
      modelId: request.modelId,
      prediction: {
        score: 0.5,
        confidence: 0.2,
        uncertainty: 0.8,
        semanticCertainty: 0.1,
        evidenceCoverage: 0,
        retrievalStability: 0.3,
        featureImportance: [],
        modelId: `${request.modelId}-degraded`,
        modelVersion: 'degraded',
        latencyMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      } as MLPrediction,
      cached: false,
      latencyMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  private async flushBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    const batch = this.pendingBatch.splice(0, this.config.maxBatchSize);
    if (batch.length === 0) return;

    this.metrics.batchSizes.push(batch.length);
    if (this.metrics.batchSizes.length > 100) this.metrics.batchSizes.shift();

    // Execute batch items individually (providers can optimize internally)
    const promises = batch.map(async (item) => {
      try {
        const result = await this.infer(item.request);
        item.resolve(result);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    await Promise.allSettled(promises);
  }

  private isCircuitOpen(): boolean {
    if (!this.circuitBreaker.isOpen) return false;

    // Check if reset time has passed
    if (this.circuitBreaker.openedAt &&
        Date.now() - this.circuitBreaker.openedAt > this.config.circuitBreakerResetMs) {
      logger.info('[MLInferenceRuntime] Circuit breaker reset (half-open)');
      this.circuitBreaker.isOpen = false;
      this.circuitBreaker.failureCount = 0;
      return false;
    }

    return true;
  }

  private tripCircuitBreaker(): void {
    logger.warn('[MLInferenceRuntime] Circuit breaker tripped');
    this.circuitBreaker.isOpen = true;
    this.circuitBreaker.openedAt = Date.now();
  }

  private trackLatency(latencyMs: number): void {
    this.metrics.latencies.push(latencyMs);
    if (this.metrics.latencies.length > 1000) this.metrics.latencies.shift();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
