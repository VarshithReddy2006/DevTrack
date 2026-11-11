// src/shared/circuit-breaker/circuitBreaker.ts — Generic Circuit Breaker
// Wraps external calls (LeetCode API, GitHub API, Redis) with failure tracking.
// States: CLOSED (normal) → OPEN (failing, skip calls) → HALF_OPEN (probe one call).

import { logger } from '../logger.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Name for logging/metrics */
  name: string;
  /** Number of consecutive failures before opening the circuit */
  failureThreshold: number;
  /** How long (ms) to stay open before trying a probe request */
  resetTimeoutMs: number;
  /** Optional: maximum extra cooldown to spread recovery across processes */
  resetJitterMs?: number;
  /** Optional: number of successes in half-open before closing again */
  successThreshold?: number;
  /** Optional: called when state changes */
  onStateChange?: (from: CircuitState, to: CircuitState, name: string) => void;
}

export class CircuitOpenError extends Error {
  public readonly circuitName: string;
  public readonly retryAfterMs: number;

  constructor(name: string, retryAfterMs: number) {
    super(`Circuit breaker "${name}" is OPEN — call rejected. Retry after ${retryAfterMs}ms.`);
    this.name = 'CircuitOpenError';
    this.circuitName = name;
    this.retryAfterMs = retryAfterMs;
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private openUntil = 0;
  private generation = 0;
  private probeInFlight = false;
  private readonly options: Required<CircuitBreakerOptions>;

  // Metrics
  private totalCalls = 0;
  private totalFailures = 0;
  private totalRejected = 0;
  private totalSuccesses = 0;

  constructor(opts: CircuitBreakerOptions) {
    this.options = {
      successThreshold: 2,
      resetJitterMs: 0,
      onStateChange: () => {},
      ...opts,
    };
  }

  // ─── Execute a function through the circuit breaker ────────────────────

  async execute<T>(fn: (state: CircuitState) => Promise<T>, fallback?: () => T): Promise<T> {
    this.totalCalls++;

    const retryAfterMs = Math.max(0, this.openUntil - Date.now());
    if (this.state === 'open' && retryAfterMs === 0) {
      this.transitionTo('half_open');
    }
    if (this.state === 'open' || this.probeInFlight) {
      this.totalRejected++;
      if (fallback) return fallback();
      throw new CircuitOpenError(this.options.name, retryAfterMs);
    }

    const generation = this.generation;
    const state = this.state;
    if (state === 'half_open') this.probeInFlight = true;
    try {
      const result = await fn(state);
      this.totalSuccesses++;
      if (generation === this.generation) this.onSuccess();
      return result;
    } catch (err) {
      this.totalFailures++;
      if (generation === this.generation) this.onFailure();
      throw err;
    } finally {
      if (generation === this.generation && state === 'half_open') this.probeInFlight = false;
    }
  }

  // ─── State transitions ─────────────────────────────────────────────────

  private onSuccess(): void {
    if (this.state === 'half_open') {
      this.successCount++;
      if (this.successCount >= this.options.successThreshold) {
        this.transitionTo('closed');
      }
    }

    // Reset failure count on any success in closed state
    if (this.state === 'closed') {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half_open') {
      // Any failure in half-open immediately reopens
      this.transitionTo('open');
      return;
    }

    if (this.state === 'closed' && this.failureCount >= this.options.failureThreshold) {
      this.transitionTo('open');
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;
    this.generation++;
    this.probeInFlight = false;
    if (newState === 'open') {
      const jitter = this.options.resetJitterMs ? Math.floor(Math.random() * this.options.resetJitterMs) : 0;
      this.openUntil = Date.now() + this.options.resetTimeoutMs + jitter;
    }
    if (newState === 'closed') this.failureCount = 0;
    this.successCount = 0;

    logger.warn(`[circuit-breaker] ${this.options.name}: ${oldState} → ${newState}`, {
      event: 'circuit_breaker_state_change',
      circuitName: this.options.name,
      from: oldState,
      to: newState,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalRejected: this.totalRejected,
    });

    this.options.onStateChange(oldState, newState, this.options.name);
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────

  getState(): CircuitState {
    return this.state;
  }

  getMetrics() {
    return {
      name: this.options.name,
      state: this.state,
      totalCalls: this.totalCalls,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      totalRejected: this.totalRejected,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : null,
    };
  }

  /** Force reset — for operational recovery */
  reset(): void {
    this.transitionTo('closed');
    this.generation++;
    this.failureCount = 0;
    this.successCount = 0;
  }
}

// ---------------------------------------------------------------------------
// Pre-configured circuit breakers for DevTrack external providers
// ---------------------------------------------------------------------------

export const circuitBreakers = {
  leetcode: new CircuitBreaker({
    name: 'leetcode-api',
    failureThreshold: 5,
    resetTimeoutMs: 60_000, // 60s cooldown
  }),
  github: new CircuitBreaker({
    name: 'github-api',
    failureThreshold: 5,
    resetTimeoutMs: 60_000,
  }),
  codeforces: new CircuitBreaker({
    name: 'codeforces-api',
    failureThreshold: 3,
    resetTimeoutMs: 120_000, // 2 min — CF is more flaky
  }),
  codechef: new CircuitBreaker({
    name: 'codechef-scraper',
    failureThreshold: 3,
    resetTimeoutMs: 120_000, // 2 min — scraper-based, fragile
  }),
  redis: new CircuitBreaker({
    name: 'redis',
    failureThreshold: 10,
    resetTimeoutMs: 5_000, // 5s — Redis should recover fast
  }),
};
