// src/shared/observability/sloEngine.ts — SLO Engine with multi-window burn-rate calculation
// ============================================================================
// Implements Google SRE multi-window, multi-burn-rate alerting model.
// Tracks availability (5xx error rate) and latency (p95 < threshold) SLOs
// using in-memory circular buffers with configurable sliding windows.
// ============================================================================

import { logger } from '../logger.js';
import { dispatchBurnRateAlert, type BurnRateAlert } from './burnRateAlerts.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SloConfig {
  /** Availability target as a fraction, e.g. 0.995 for 99.5% */
  availabilityTarget: number;
  /** Latency SLO: fraction of requests that must be below latencyThresholdMs */
  latencyTarget: number;
  /** Latency threshold in ms (non-LLM requests) */
  latencyThresholdMs: number;
  /** SLO evaluation period in seconds (default: 30 days) */
  windowSeconds: number;
  /** Critical burn-rate multiplier (default: 14.4×) */
  criticalBurnRate: number;
  /** Warning burn-rate multiplier (default: 6.0×) */
  warningBurnRate: number;
}

const DEFAULT_CONFIG: SloConfig = {
  availabilityTarget: 0.995,
  latencyTarget: 0.95,
  latencyThresholdMs: 120,
  windowSeconds: 30 * 24 * 60 * 60, // 30 days
  criticalBurnRate: 14.4,
  warningBurnRate: 6.0,
};

// ---------------------------------------------------------------------------
// Circular buffer for sliding window metrics
// ---------------------------------------------------------------------------

interface MetricBucket {
  /** Bucket start timestamp (epoch ms) */
  timestamp: number;
  /** Total requests in this bucket */
  totalRequests: number;
  /** Failed requests (5xx) in this bucket */
  failedRequests: number;
  /** Requests exceeding latency threshold */
  slowRequests: number;
}

const BUCKET_DURATION_MS = 60_000; // 1-minute buckets
const MAX_BUCKETS = 6 * 60; // 6 hours of 1-minute buckets

// ---------------------------------------------------------------------------
// SLO Engine
// ---------------------------------------------------------------------------

export class SloEngine {
  private readonly config: SloConfig;
  private readonly buckets: MetricBucket[] = [];
  private degradedMode = false;
  private lastAlertTimestamp = 0;
  private readonly alertCooldownMs: number;

  constructor(config: Partial<SloConfig> = {}, alertCooldownMs = 300_000) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.alertCooldownMs = alertCooldownMs;
  }

  // ── Recording ──────────────────────────────────────────────────────────

  /**
   * Record an HTTP request outcome for SLO tracking.
   * @param statusCode - HTTP status code
   * @param latencyMs  - Request latency in milliseconds
   * @param isLlmRequest - Whether this is an LLM request (excluded from latency SLO)
   * @param now - Optional timestamp for deterministic testing
   */
  recordRequest(
    statusCode: number,
    latencyMs: number,
    isLlmRequest = false,
    now = Date.now(),
  ): void {
    const bucket = this.getOrCreateBucket(now);
    bucket.totalRequests++;

    if (statusCode >= 500) {
      bucket.failedRequests++;
    }

    // Latency SLO only applies to non-LLM requests
    if (!isLlmRequest && latencyMs > this.config.latencyThresholdMs) {
      bucket.slowRequests++;
    }

    this.pruneOldBuckets(now);
  }

  // ── Evaluation ─────────────────────────────────────────────────────────

  /**
   * Evaluate SLO compliance and burn rates across all configured windows.
   * @param now - Optional timestamp for deterministic testing
   */
  evaluate(now = Date.now()): SloEvaluation {
    this.pruneOldBuckets(now);

    const shortWindow = this.computeWindowMetrics(5 * 60_000, now);    // 5 minutes
    const mediumWindow = this.computeWindowMetrics(30 * 60_000, now);  // 30 minutes
    const longShortWindow = this.computeWindowMetrics(60 * 60_000, now); // 1 hour
    const longWindow = this.computeWindowMetrics(6 * 60 * 60_000, now);  // 6 hours

    const availabilityBudget = this.computeErrorBudget(now);
    const latencyBudget = this.computeLatencyBudget(now);

    // Multi-window burn-rate alerting (Google SRE model):
    // Critical: short window (5m) AND confirmation window (1h) both exceed critical rate
    // Warning: medium window (30m) AND confirmation window (6h) both exceed warning rate
    const shortAvailBurnRate = this.computeBurnRate(shortWindow, 'availability');
    const longShortAvailBurnRate = this.computeBurnRate(longShortWindow, 'availability');
    const mediumAvailBurnRate = this.computeBurnRate(mediumWindow, 'availability');
    const longAvailBurnRate = this.computeBurnRate(longWindow, 'availability');

    const shortLatencyBurnRate = this.computeBurnRate(shortWindow, 'latency');
    const longShortLatencyBurnRate = this.computeBurnRate(longShortWindow, 'latency');
    const mediumLatencyBurnRate = this.computeBurnRate(mediumWindow, 'latency');
    const longLatencyBurnRate = this.computeBurnRate(longWindow, 'latency');

    const criticalAvailability =
      shortAvailBurnRate >= this.config.criticalBurnRate &&
      longShortAvailBurnRate >= this.config.criticalBurnRate;

    const warningAvailability =
      mediumAvailBurnRate >= this.config.warningBurnRate &&
      longAvailBurnRate >= this.config.warningBurnRate;

    const criticalLatency =
      shortLatencyBurnRate >= this.config.criticalBurnRate &&
      longShortLatencyBurnRate >= this.config.criticalBurnRate;

    const warningLatency =
      mediumLatencyBurnRate >= this.config.warningBurnRate &&
      longLatencyBurnRate >= this.config.warningBurnRate;

    let severity: 'ok' | 'warning' | 'critical' = 'ok';
    if (criticalAvailability || criticalLatency) {
      severity = 'critical';
    } else if (warningAvailability || warningLatency) {
      severity = 'warning';
    }

    // Update degraded mode
    if (severity === 'critical') {
      this.degradedMode = true;
    } else if (severity === 'ok') {
      this.degradedMode = false;
    }

    // Dispatch alerts with cooldown
    if (severity !== 'ok' && now - this.lastAlertTimestamp > this.alertCooldownMs) {
      this.lastAlertTimestamp = now;
      const alert: BurnRateAlert = {
        severity,
        timestamp: new Date(now).toISOString(),
        availability: {
          burnRate: shortAvailBurnRate,
          budgetRemaining: availabilityBudget.budgetRemainingFraction,
          windowSeconds: 300,
        },
        latency: {
          burnRate: shortLatencyBurnRate,
          budgetRemaining: latencyBudget.budgetRemainingFraction,
          windowSeconds: 300,
        },
        degradedMode: this.degradedMode,
      };
      dispatchBurnRateAlert(alert).catch((err) => {
        logger.error('[slo] Failed to dispatch burn-rate alert', err);
      });
    }

    const evaluation: SloEvaluation = {
      timestamp: new Date(now).toISOString(),
      config: { ...this.config },
      severity,
      degradedMode: this.degradedMode,
      availability: {
        current: availabilityBudget.currentRate,
        target: this.config.availabilityTarget,
        budgetTotal: availabilityBudget.budgetTotal,
        budgetConsumed: availabilityBudget.budgetConsumed,
        budgetRemainingFraction: availabilityBudget.budgetRemainingFraction,
        burnRates: {
          shortWindow: { windowLabel: '5m', rate: shortAvailBurnRate },
          longShortWindow: { windowLabel: '1h', rate: longShortAvailBurnRate },
          mediumWindow: { windowLabel: '30m', rate: mediumAvailBurnRate },
          longWindow: { windowLabel: '6h', rate: longAvailBurnRate },
        },
      },
      latency: {
        current: latencyBudget.currentRate,
        target: this.config.latencyTarget,
        thresholdMs: this.config.latencyThresholdMs,
        budgetTotal: latencyBudget.budgetTotal,
        budgetConsumed: latencyBudget.budgetConsumed,
        budgetRemainingFraction: latencyBudget.budgetRemainingFraction,
        burnRates: {
          shortWindow: { windowLabel: '5m', rate: shortLatencyBurnRate },
          longShortWindow: { windowLabel: '1h', rate: longShortLatencyBurnRate },
          mediumWindow: { windowLabel: '30m', rate: mediumLatencyBurnRate },
          longWindow: { windowLabel: '6h', rate: longLatencyBurnRate },
        },
      },
    };

    return evaluation;
  }

  // ── Status ─────────────────────────────────────────────────────────────

  isDegraded(): boolean {
    return this.degradedMode;
  }

  getConfig(): Readonly<SloConfig> {
    return { ...this.config };
  }

  /**
   * Reset all state (useful for testing).
   */
  reset(): void {
    this.buckets.length = 0;
    this.degradedMode = false;
    this.lastAlertTimestamp = 0;
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private getOrCreateBucket(now: number): MetricBucket {
    const bucketTs = Math.floor(now / BUCKET_DURATION_MS) * BUCKET_DURATION_MS;
    const last = this.buckets[this.buckets.length - 1];

    if (last && last.timestamp === bucketTs) {
      return last;
    }

    const bucket: MetricBucket = {
      timestamp: bucketTs,
      totalRequests: 0,
      failedRequests: 0,
      slowRequests: 0,
    };
    this.buckets.push(bucket);
    return bucket;
  }

  private pruneOldBuckets(now: number): void {
    const cutoff = now - MAX_BUCKETS * BUCKET_DURATION_MS;
    while (this.buckets.length > 0 && this.buckets[0].timestamp < cutoff) {
      this.buckets.shift();
    }
  }

  private computeWindowMetrics(windowMs: number, now: number): WindowMetrics {
    const cutoff = now - windowMs;
    let totalRequests = 0;
    let failedRequests = 0;
    let slowRequests = 0;

    for (let i = 0; i < this.buckets.length; i++) {
      const bucket = this.buckets[i];
      if (bucket.timestamp >= cutoff) {
        totalRequests += bucket.totalRequests;
        failedRequests += bucket.failedRequests;
        slowRequests += bucket.slowRequests;
      }
    }

    return { totalRequests, failedRequests, slowRequests, windowMs };
  }

  /**
   * Burn rate = (observed error rate in window) / (allowed error rate from SLO budget).
   * A burn rate of 1.0 means the error budget is being consumed at exactly the
   * sustainable rate. 14.4× means the monthly budget would be exhausted in ~2 days.
   */
  private computeBurnRate(
    metrics: WindowMetrics,
    type: 'availability' | 'latency',
  ): number {
    if (metrics.totalRequests === 0) return 0;

    if (type === 'availability') {
      const errorRate = metrics.failedRequests / metrics.totalRequests;
      const allowedErrorRate = 1 - this.config.availabilityTarget;
      const rate = allowedErrorRate > 0 ? errorRate / allowedErrorRate : 0;
      return Number(rate.toFixed(4));
    } else {
      const slowRate = metrics.slowRequests / metrics.totalRequests;
      const allowedSlowRate = 1 - this.config.latencyTarget;
      const rate = allowedSlowRate > 0 ? slowRate / allowedSlowRate : 0;
      return Number(rate.toFixed(4));
    }
  }

  private computeErrorBudget(now: number): BudgetStatus {
    const allMetrics = this.computeWindowMetrics(
      MAX_BUCKETS * BUCKET_DURATION_MS,
      now,
    );

    const allowedErrorRate = Number((1 - this.config.availabilityTarget).toFixed(6));
    const budgetTotal = Math.round(allMetrics.totalRequests * allowedErrorRate * 1000) / 1000;
    const budgetConsumed = allMetrics.failedRequests;
    const budgetRemainingFraction =
      budgetTotal > 0
        ? Math.max(0, Number((1 - budgetConsumed / budgetTotal).toFixed(4)))
        : 1;
    const currentRate =
      allMetrics.totalRequests > 0
        ? Number((1 - allMetrics.failedRequests / allMetrics.totalRequests).toFixed(6))
        : 1;

    return { currentRate, budgetTotal, budgetConsumed, budgetRemainingFraction };
  }

  private computeLatencyBudget(now: number): BudgetStatus {
    const allMetrics = this.computeWindowMetrics(
      MAX_BUCKETS * BUCKET_DURATION_MS,
      now,
    );

    const allowedSlowRate = Number((1 - this.config.latencyTarget).toFixed(6));
    const budgetTotal = Math.round(allMetrics.totalRequests * allowedSlowRate * 1000) / 1000;
    const budgetConsumed = allMetrics.slowRequests;
    const budgetRemainingFraction =
      budgetTotal > 0
        ? Math.max(0, Number((1 - budgetConsumed / budgetTotal).toFixed(4)))
        : 1;
    const currentRate =
      allMetrics.totalRequests > 0
        ? Number((1 - allMetrics.slowRequests / allMetrics.totalRequests).toFixed(6))
        : 1;

    return { currentRate, budgetTotal, budgetConsumed, budgetRemainingFraction };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WindowMetrics {
  totalRequests: number;
  failedRequests: number;
  slowRequests: number;
  windowMs: number;
}

interface BudgetStatus {
  currentRate: number;
  budgetTotal: number;
  budgetConsumed: number;
  budgetRemainingFraction: number;
}

interface BurnRateWindow {
  windowLabel: string;
  rate: number;
}

export interface SloEvaluation {
  timestamp: string;
  config: SloConfig;
  severity: 'ok' | 'warning' | 'critical';
  degradedMode: boolean;
  availability: {
    current: number;
    target: number;
    budgetTotal: number;
    budgetConsumed: number;
    budgetRemainingFraction: number;
    burnRates: {
      shortWindow: BurnRateWindow;
      longShortWindow: BurnRateWindow;
      mediumWindow: BurnRateWindow;
      longWindow: BurnRateWindow;
    };
  };
  latency: {
    current: number;
    target: number;
    thresholdMs: number;
    budgetTotal: number;
    budgetConsumed: number;
    budgetRemainingFraction: number;
    burnRates: {
      shortWindow: BurnRateWindow;
      longShortWindow: BurnRateWindow;
      mediumWindow: BurnRateWindow;
      longWindow: BurnRateWindow;
    };
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const sloEngine = new SloEngine();

