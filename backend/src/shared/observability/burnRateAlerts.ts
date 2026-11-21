// src/shared/observability/burnRateAlerts.ts — Alert dispatch for SLO burn-rate violations
// ============================================================================
// Dispatches webhook alerts and logs when burn rates exceed SLO thresholds.
// In production, this would POST to PagerDuty, Slack, or a generic webhook.
// ============================================================================

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BurnRateAlert {
  severity: 'warning' | 'critical';
  timestamp: string;
  availability: {
    burnRate: number;
    budgetRemaining: number;
    windowSeconds: number;
  };
  latency: {
    burnRate: number;
    budgetRemaining: number;
    windowSeconds: number;
  };
  degradedMode: boolean;
}

export interface AlertWebhookConfig {
  /** Webhook URL to POST alerts to */
  url: string;
  /** Optional authorization header */
  authorizationHeader?: string;
  /** Timeout in ms (default: 5000) */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Alert dispatch
// ---------------------------------------------------------------------------

/** Override for testing — set via setAlertHandler */
let alertHandler: ((alert: BurnRateAlert) => Promise<void>) | null = null;

/**
 * Set a custom alert handler (useful for testing or non-HTTP alert channels).
 */
export function setAlertHandler(
  handler: ((alert: BurnRateAlert) => Promise<void>) | null,
): void {
  alertHandler = handler;
}

/**
 * Dispatch a burn-rate alert. Uses custom handler if set, otherwise logs
 * and optionally POSTs to SLO_ALERT_WEBHOOK_URL if configured.
 */
export async function dispatchBurnRateAlert(alert: BurnRateAlert): Promise<void> {
  // Custom handler takes precedence
  if (alertHandler) {
    await alertHandler(alert);
    return;
  }

  // Always log the alert
  const logMethod = alert.severity === 'critical' ? 'error' : 'warn';
  logger[logMethod]('[slo] Burn-rate alert fired', {
    severity: alert.severity,
    availabilityBurnRate: alert.availability.burnRate,
    availabilityBudgetRemaining: alert.availability.budgetRemaining,
    latencyBurnRate: alert.latency.burnRate,
    latencyBudgetRemaining: alert.latency.budgetRemaining,
    degradedMode: alert.degradedMode,
  });

  // POST to webhook if configured
  const webhookUrl = process.env.SLO_ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const authHeader = process.env.SLO_ALERT_WEBHOOK_AUTH;
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(alert),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
  } catch (err) {
    logger.error('[slo] Failed to deliver webhook alert', err, {
      url: webhookUrl,
    });
  }
}

