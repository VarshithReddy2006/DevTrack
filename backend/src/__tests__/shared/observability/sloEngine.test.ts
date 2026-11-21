// src/__tests__/shared/observability/sloEngine.test.ts
// ============================================================================
// Unit tests for the SLO Engine — multi-window burn-rate calculations,
// error budget tracking, alert dispatch, and degraded mode toggling.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SloEngine, sloEngine } from '../../../shared/observability/sloEngine.js';
import { setAlertHandler, type BurnRateAlert } from '../../../shared/observability/burnRateAlerts.js';
import { opsController } from '../../../modules/ops/ops.controller.js';
import type { AuthenticatedRequest } from '../../../middleware/auth.js';
import type { Response } from 'express';

// Helpers
const BASE_TIME = Date.parse('2026-11-21T00:00:00Z');
const MINUTE = 60_000;

function recordBatch(
  engine: SloEngine,
  opts: {
    total: number;
    failedFraction?: number;
    slowFraction?: number;
    startTime?: number;
    spreadMinutes?: number;
  },
): void {
  const {
    total,
    failedFraction = 0,
    slowFraction = 0,
    startTime = BASE_TIME,
    spreadMinutes = 1,
  } = opts;

  const failed = Math.round(total * failedFraction);
  const slow = Math.round(total * slowFraction);

  for (let i = 0; i < total; i++) {
    const t = startTime + Math.floor((i / total) * spreadMinutes) * MINUTE;
    const statusCode = i < failed ? 500 : 200;
    const latencyMs = i >= failed && i < failed + slow ? 200 : 50;
    engine.recordRequest(statusCode, latencyMs, false, t);
  }
}

describe('SloEngine', () => {
  let engine: SloEngine;
  let alerts: BurnRateAlert[];

  beforeEach(() => {
    alerts = [];
    setAlertHandler(async (alert) => {
      alerts.push(alert);
    });
    engine = new SloEngine(
      {
        availabilityTarget: 0.995,
        latencyTarget: 0.95,
        latencyThresholdMs: 120,
        criticalBurnRate: 14.4,
        warningBurnRate: 6.0,
      },
      0, // No alert cooldown for testing
    );
  });

  afterEach(() => {
    setAlertHandler(null);
  });

  // ─── Basic recording and evaluation ────────────────────────────────────

  describe('basic recording', () => {
    it('should start with zero traffic and severity "ok"', () => {
      const evaluation = engine.evaluate(BASE_TIME);

      expect(evaluation.severity).toBe('ok');
      expect(evaluation.degradedMode).toBe(false);
      expect(evaluation.availability.current).toBe(1);
      expect(evaluation.latency.current).toBe(1);
      expect(evaluation.availability.budgetRemainingFraction).toBe(1);
      expect(evaluation.latency.budgetRemainingFraction).toBe(1);
    });

    it('should track successful requests correctly', () => {
      // Record 1000 successful, fast requests
      recordBatch(engine, { total: 1000, startTime: BASE_TIME, spreadMinutes: 5 });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.severity).toBe('ok');
      expect(evaluation.availability.current).toBe(1);
      expect(evaluation.latency.current).toBe(1);
      expect(evaluation.availability.budgetRemainingFraction).toBe(1);
      expect(evaluation.latency.budgetRemainingFraction).toBe(1);
    });

    it('should correctly calculate availability with some failures', () => {
      // 1000 requests, 1% failure rate (above 0.5% allowed)
      recordBatch(engine, {
        total: 1000,
        failedFraction: 0.01,
        startTime: BASE_TIME,
        spreadMinutes: 5,
      });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      // 990/1000 = 0.99 availability
      expect(evaluation.availability.current).toBeCloseTo(0.99, 2);
      // Budget consumed: 10 failures out of allowed 5 (1000 * 0.005)
      expect(evaluation.availability.budgetConsumed).toBe(10);
      expect(evaluation.availability.budgetTotal).toBe(5);
      expect(evaluation.availability.budgetRemainingFraction).toBe(0);
    });

    it('should exclude LLM requests from latency SLO tracking', () => {
      // Record slow LLM requests — should not count as slow
      for (let i = 0; i < 100; i++) {
        engine.recordRequest(200, 500, true, BASE_TIME + i * 100);
      }

      const evaluation = engine.evaluate(BASE_TIME + MINUTE);
      expect(evaluation.latency.current).toBe(1);
      expect(evaluation.latency.budgetConsumed).toBe(0);
    });
  });

  // ─── Burn-rate calculations ────────────────────────────────────────────

  describe('burn-rate calculations', () => {
    it('should compute burn rate = 0 with no errors', () => {
      recordBatch(engine, { total: 1000, startTime: BASE_TIME, spreadMinutes: 5 });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.availability.burnRates.shortWindow.rate).toBe(0);
      expect(evaluation.latency.burnRates.shortWindow.rate).toBe(0);
    });

    it('should compute burn rate of 2.0 when error rate is 2× the allowed rate', () => {
      // Allowed error rate = 0.5%. Recording 1% errors = 2× burn rate.
      recordBatch(engine, {
        total: 1000,
        failedFraction: 0.01,
        startTime: BASE_TIME,
        spreadMinutes: 5,
      });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.availability.burnRates.shortWindow.rate).toBeCloseTo(2.0, 1);
    });

    it('should compute burn rate = 0 when no requests recorded', () => {
      const evaluation = engine.evaluate(BASE_TIME);

      expect(evaluation.availability.burnRates.shortWindow.rate).toBe(0);
      expect(evaluation.availability.burnRates.longWindow.rate).toBe(0);
    });

    it('should compute latency burn rate when slow requests exceed threshold', () => {
      // Allowed slow rate = 5%. Recording 10% slow = 2× burn rate.
      recordBatch(engine, {
        total: 1000,
        slowFraction: 0.10,
        startTime: BASE_TIME,
        spreadMinutes: 5,
      });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.latency.burnRates.shortWindow.rate).toBeCloseTo(2.0, 1);
    });
  });

  // ─── Multi-window alerting ─────────────────────────────────────────────

  describe('multi-window alerting', () => {
    it('should fire critical alert when both short and 1h windows exceed 14.4× burn rate', () => {
      // Flood with 10% errors across the past hour to exceed 14.4× on both windows
      // 10% / 0.5% = 20× burn rate
      for (let minute = 0; minute < 60; minute++) {
        recordBatch(engine, {
          total: 100,
          failedFraction: 0.10,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }

      const evaluation = engine.evaluate(BASE_TIME + 60 * MINUTE);

      expect(evaluation.severity).toBe('critical');
      expect(evaluation.degradedMode).toBe(true);
      expect(evaluation.availability.burnRates.shortWindow.rate).toBeGreaterThanOrEqual(14.4);
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(alerts[0].severity).toBe('critical');
    });

    it('should fire warning when medium and 6h windows exceed 6× burn rate', () => {
      // 5% errors across 6 hours → 5%/0.5% = 10× burn rate (exceeds warning threshold 6.0, below critical 14.4)
      for (let minute = 0; minute < 360; minute++) {
        recordBatch(engine, {
          total: 20,
          failedFraction: 0.05,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }

      const evaluation = engine.evaluate(BASE_TIME + 360 * MINUTE);

      expect(evaluation.severity).toBe('warning');
      // The key assertion: burn rates are above warning threshold
      expect(evaluation.availability.burnRates.mediumWindow.rate).toBeGreaterThanOrEqual(6.0);
      expect(evaluation.availability.burnRates.longWindow.rate).toBeGreaterThanOrEqual(6.0);
    });

    it('should stay "ok" when burn rates are below warning threshold', () => {
      // 0.2% error rate is below 0.5% SLO threshold → burn rate < 1.0
      recordBatch(engine, {
        total: 1000,
        failedFraction: 0.002,
        startTime: BASE_TIME,
        spreadMinutes: 5,
      });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.severity).toBe('ok');
      expect(evaluation.availability.burnRates.shortWindow.rate).toBeLessThan(1.0);
      expect(alerts.length).toBe(0);
    });

    it('should not fire critical if only short window exceeds but 1h does not', () => {
      // 1 hour of clean traffic, then a 5-minute spike
      for (let minute = 0; minute < 55; minute++) {
        recordBatch(engine, {
          total: 100,
          failedFraction: 0,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }
      // 5-minute spike: 10% errors
      for (let minute = 55; minute < 60; minute++) {
        recordBatch(engine, {
          total: 100,
          failedFraction: 0.10,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }

      const evaluation = engine.evaluate(BASE_TIME + 60 * MINUTE);

      // Short window should have high burn rate, but 1h window should be diluted
      expect(evaluation.availability.burnRates.shortWindow.rate).toBeGreaterThan(10);
      expect(evaluation.availability.burnRates.longShortWindow.rate).toBeLessThan(14.4);
      // So should NOT be critical
      expect(evaluation.severity).not.toBe('critical');
    });
  });

  // ─── Degraded mode ─────────────────────────────────────────────────────

  describe('degraded mode', () => {
    it('should enter degraded mode on critical severity', () => {
      for (let minute = 0; minute < 60; minute++) {
        recordBatch(engine, {
          total: 100,
          failedFraction: 0.15,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }

      engine.evaluate(BASE_TIME + 60 * MINUTE);
      expect(engine.isDegraded()).toBe(true);
    });

    it('should exit degraded mode when severity returns to ok', () => {
      // Create critical state
      for (let minute = 0; minute < 60; minute++) {
        recordBatch(engine, {
          total: 100,
          failedFraction: 0.15,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }

      engine.evaluate(BASE_TIME + 60 * MINUTE);
      expect(engine.isDegraded()).toBe(true);

      // Reset and record clean traffic
      engine.reset();
      recordBatch(engine, {
        total: 10000,
        failedFraction: 0,
        startTime: BASE_TIME + 120 * MINUTE,
        spreadMinutes: 60,
      });

      engine.evaluate(BASE_TIME + 180 * MINUTE);
      expect(engine.isDegraded()).toBe(false);
    });
  });

  // ─── Error budget tracking ─────────────────────────────────────────────

  describe('error budget', () => {
    it('should show 100% budget remaining with no errors', () => {
      recordBatch(engine, { total: 1000, startTime: BASE_TIME, spreadMinutes: 5 });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.availability.budgetRemainingFraction).toBe(1);
      expect(evaluation.latency.budgetRemainingFraction).toBe(1);
    });

    it('should show 0% budget remaining when errors exceed budget', () => {
      // Allowed: 0.5% → 5 out of 1000. Send 10 failures.
      recordBatch(engine, {
        total: 1000,
        failedFraction: 0.01,
        startTime: BASE_TIME,
        spreadMinutes: 5,
      });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.availability.budgetRemainingFraction).toBe(0);
    });

    it('should show 50% budget remaining when half the budget is consumed', () => {
      // 1000 requests, allowed 5 errors (0.5%). Record ~2-3 errors → ~50%
      // We'll record exactly 2.5 errors worth which needs fractional. Use 2000 requests.
      // 2000 * 0.005 = 10 allowed. Record 5 failures = 50% consumed.
      recordBatch(engine, {
        total: 2000,
        failedFraction: 0.0025, // 5 failures
        startTime: BASE_TIME,
        spreadMinutes: 5,
      });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.availability.budgetRemainingFraction).toBeCloseTo(0.5, 1);
    });
  });

  // ─── Alert cooldown ────────────────────────────────────────────────────

  describe('alert cooldown', () => {
    it('should respect alert cooldown period', () => {
      const cooledEngine = new SloEngine({}, 60_000); // 60s cooldown

      // Fire two evaluations within cooldown
      for (let minute = 0; minute < 60; minute++) {
        recordBatch(cooledEngine, {
          total: 100,
          failedFraction: 0.15,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }

      cooledEngine.evaluate(BASE_TIME + 60 * MINUTE);
      cooledEngine.evaluate(BASE_TIME + 60 * MINUTE + 10_000); // 10s later

      // Only one alert should have been dispatched
      expect(alerts.length).toBe(1);

      // After cooldown, another should fire
      cooledEngine.evaluate(BASE_TIME + 60 * MINUTE + 61_000);
      expect(alerts.length).toBe(2);
    });
  });

  // ─── Configuration ─────────────────────────────────────────────────────

  describe('configuration', () => {
    it('should expose read-only config', () => {
      const config = engine.getConfig();
      expect(config.availabilityTarget).toBe(0.995);
      expect(config.latencyTarget).toBe(0.95);
      expect(config.latencyThresholdMs).toBe(120);
      expect(config.criticalBurnRate).toBe(14.4);
      expect(config.warningBurnRate).toBe(6.0);
    });

    it('should allow custom SLO targets', () => {
      const customEngine = new SloEngine({
        availabilityTarget: 0.999,
        latencyTarget: 0.99,
        latencyThresholdMs: 200,
      });

      const config = customEngine.getConfig();
      expect(config.availabilityTarget).toBe(0.999);
      expect(config.latencyTarget).toBe(0.99);
      expect(config.latencyThresholdMs).toBe(200);
    });
  });

  // ─── Bucket pruning ────────────────────────────────────────────────────

  describe('bucket management', () => {
    it('should prune old buckets beyond the max window', () => {
      // Record traffic at t=0
      recordBatch(engine, { total: 100, failedFraction: 0.5, startTime: BASE_TIME, spreadMinutes: 1 });

      // Jump 7 hours ahead (beyond 6-hour max buffer)
      const laterTime = BASE_TIME + 7 * 60 * MINUTE;
      recordBatch(engine, { total: 100, startTime: laterTime, spreadMinutes: 1 });

      const evaluation = engine.evaluate(laterTime + MINUTE);

      // The old 50% error rate should be pruned — only clean traffic remains
      expect(evaluation.availability.current).toBe(1);
    });
  });

  // ─── Outage simulation ────────────────────────────────────────────────

  describe('simulated outage scenarios', () => {
    it('should detect a 14.4× burn rate outage that exhausts monthly budget in 2 days', () => {
      // 14.4× burn rate on 0.5% SLO = 7.2% error rate
      // 1000 requests per minute with 72 errors = exactly 7.2% / 0.5% = 14.4× burn rate
      // Sustain this for 1 hour across both windows
      for (let minute = 0; minute < 60; minute++) {
        recordBatch(engine, {
          total: 1000,
          failedFraction: 0.072,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }

      const evaluation = engine.evaluate(BASE_TIME + 60 * MINUTE);

      // Both short and 1h windows should show ~14.4× burn rate
      expect(evaluation.availability.burnRates.shortWindow.rate).toBeCloseTo(14.4, 0);
      expect(evaluation.availability.burnRates.longShortWindow.rate).toBeCloseTo(14.4, 0);
      expect(evaluation.severity).toBe('critical');
      expect(evaluation.degradedMode).toBe(true);
    });

    it('should detect minor degradation below warning threshold', () => {
      // 1.5% error rate → 1.5/0.5 = 3× burn rate (below 6× warning)
      recordBatch(engine, {
        total: 1000,
        failedFraction: 0.015,
        startTime: BASE_TIME,
        spreadMinutes: 5,
      });

      const evaluation = engine.evaluate(BASE_TIME + 5 * MINUTE);

      expect(evaluation.availability.burnRates.shortWindow.rate).toBeCloseTo(3.0, 0);
      expect(evaluation.severity).toBe('ok');
      expect(alerts.length).toBe(0);
    });

    it('should detect latency-only SLO violation', () => {
      // All requests succeed, but 15% are slow → 15/5 = 3× latency burn
      // Need > 14.4× for critical: 72%+ slow requests → 72/5 = 14.4×
      for (let minute = 0; minute < 60; minute++) {
        recordBatch(engine, {
          total: 100,
          slowFraction: 0.75,
          startTime: BASE_TIME + minute * MINUTE,
          spreadMinutes: 1,
        });
      }

      const evaluation = engine.evaluate(BASE_TIME + 60 * MINUTE);

      expect(evaluation.latency.burnRates.shortWindow.rate).toBeGreaterThanOrEqual(14.4);
      expect(evaluation.availability.burnRates.shortWindow.rate).toBe(0);
      expect(evaluation.severity).toBe('critical');
    });
  });

  // ─── SloEvaluation shape ───────────────────────────────────────────────

  describe('evaluation shape', () => {
    it('should return all required fields in the evaluation', () => {
      recordBatch(engine, { total: 100, startTime: BASE_TIME, spreadMinutes: 1 });
      const evaluation = engine.evaluate(BASE_TIME + MINUTE);

      // Top-level
      expect(evaluation).toHaveProperty('timestamp');
      expect(evaluation).toHaveProperty('config');
      expect(evaluation).toHaveProperty('severity');
      expect(evaluation).toHaveProperty('degradedMode');

      // Availability
      expect(evaluation.availability).toHaveProperty('current');
      expect(evaluation.availability).toHaveProperty('target');
      expect(evaluation.availability).toHaveProperty('budgetTotal');
      expect(evaluation.availability).toHaveProperty('budgetConsumed');
      expect(evaluation.availability).toHaveProperty('budgetRemainingFraction');
      expect(evaluation.availability).toHaveProperty('burnRates');
      expect(evaluation.availability.burnRates).toHaveProperty('shortWindow');
      expect(evaluation.availability.burnRates).toHaveProperty('longShortWindow');
      expect(evaluation.availability.burnRates).toHaveProperty('mediumWindow');
      expect(evaluation.availability.burnRates).toHaveProperty('longWindow');

      // Latency
      expect(evaluation.latency).toHaveProperty('current');
      expect(evaluation.latency).toHaveProperty('target');
      expect(evaluation.latency).toHaveProperty('thresholdMs');
      expect(evaluation.latency).toHaveProperty('budgetTotal');
      expect(evaluation.latency).toHaveProperty('budgetConsumed');
      expect(evaluation.latency).toHaveProperty('budgetRemainingFraction');
      expect(evaluation.latency).toHaveProperty('burnRates');
    });
  });

  // ─── Ops Controller endpoint ───────────────────────────────────────────

  describe('opsController.sloStatus', () => {
    it('should return 200 with JSON payload containing evaluation', async () => {
      let responseBody: any = null;
      let statusCode = 200;

      const mockReq = {
        user: { role: 'admin', id: 'user_1', username: 'admin' },
      } as unknown as AuthenticatedRequest;

      const mockRes = {
        status: (code: number) => {
          statusCode = code;
          return mockRes;
        },
        json: (data: any) => {
          responseBody = data;
          return mockRes;
        },
      } as unknown as Response;

      await opsController.sloStatus(mockReq, mockRes);

      expect(statusCode).toBe(200);
      expect(responseBody).toHaveProperty('success', true);
      expect(responseBody).toHaveProperty('slo');
      expect(responseBody.slo).toHaveProperty('severity');
      expect(responseBody.slo).toHaveProperty('availability');
      expect(responseBody.slo).toHaveProperty('latency');
    });
  });
});

