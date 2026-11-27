// src/modules/ai/quota.service.ts — Per-user daily AI quota enforcement
// Uses atomic Redis counters with automatic midnight UTC expiration.

import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';
import { logger } from '../../shared/logger.js';

export const DEFAULT_AI_QUOTAS: Record<string, number> = {
  resume_rewrite: 20,
  interview: 10,
  explanation: 30,
  roadmap: 15,
  general: 25,
  default: 25,
};

export class AIQuotaExceededError extends Error {
  statusCode = 429;
  code = 'AI_QUOTA_EXCEEDED';
  feature: string;
  limit: number;
  used: number;
  resetAt: Date;

  constructor(feature: string, limit: number, used: number, resetAt: Date) {
    super(`Daily AI quota exceeded for feature '${feature}'. Limit: ${limit}, used: ${used}. Resets at ${resetAt.toISOString()}`);
    this.name = 'AIQuotaExceededError';
    this.feature = feature;
    this.limit = limit;
    this.used = used;
    this.resetAt = resetAt;
  }
}

export interface QuotaCheckResult {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
  resetAt: Date;
}

/**
 * Give one unit back. KEYS[1] = quota key.
 * Never goes below zero and never creates the key (so it keeps its TTL or stays absent).
 */
export const REFUND_QUOTA_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

export class QuotaService {
  private quotas: Record<string, number>;

  constructor(customQuotas?: Record<string, number>) {
    this.quotas = { ...DEFAULT_AI_QUOTAS, ...(customQuotas || {}) };
  }

  /**
   * Calculates the UTC reset timestamp and remaining seconds in the current UTC day.
   */
  getUtcDayBounds(now: Date = new Date()): { yyyymmdd: string; resetAt: Date; ttlSeconds: number } {
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const yyyymmdd = `${year}${month}${day}`;

    const resetAt = new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
    const ttlSeconds = Math.max(60, Math.floor((resetAt.getTime() - now.getTime()) / 1000));

    return { yyyymmdd, resetAt, ttlSeconds };
  }

  /**
   * Builds the Redis quota counter key according to v2 specification:
   * devtrack:ai:quota:<userId>:<feature>:<yyyymmdd>
   */
  getQuotaKey(userId: string, feature: string, yyyymmdd: string): string {
    return `devtrack:ai:quota:${userId}:${feature}:${yyyymmdd}`;
  }

  /**
   * Retrieves the configured quota limit for a given feature.
   */
  getLimit(feature: string): number {
    return this.quotas[feature] ?? this.quotas.default ?? 25;
  }

  /**
   * Checks and atomically increments the user's daily usage quota.
   * If usage exceeds the limit, returns allowed=false with current count and reset time.
   */
  async checkAndConsumeQuota(
    userId: string,
    feature: string = 'default',
    now: Date = new Date()
  ): Promise<QuotaCheckResult> {
    const limit = this.getLimit(feature);
    const { yyyymmdd, resetAt, ttlSeconds } = this.getUtcDayBounds(now);
    const key = this.getQuotaKey(userId, feature, yyyymmdd);

    if (!isRedisConfigured()) {
      logger.debug('[QuotaService] Redis not configured, permitting request open');
      return { allowed: true, used: 1, remaining: limit - 1, limit, resetAt };
    }

    try {
      const redis = getRedisClient();
      const used = await redis.incr(key);

      // Set TTL only on the first increment
      if (used === 1) {
        await redis.expire(key, ttlSeconds);
      }

      if (used > limit) {
        logger.warn('[QuotaService] User exceeded daily AI quota', {
          userId,
          feature,
          used,
          limit,
          resetAt: resetAt.toISOString(),
        });
        return {
          allowed: false,
          used,
          remaining: 0,
          limit,
          resetAt,
        };
      }

      return {
        allowed: true,
        used,
        remaining: Math.max(0, limit - used),
        limit,
        resetAt,
      };
    } catch (err) {
      logger.warn('[QuotaService] Redis quota check failed; failing open', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { allowed: true, used: 0, remaining: limit, limit, resetAt };
    }
  }

  /**
   * Returns current quota usage and remaining allowance for all features for a user.
   */
  async getQuotaStatus(
    userId: string,
    features: string[] = ['resume_rewrite', 'interview', 'explanation', 'roadmap', 'general'],
    now: Date = new Date()
  ): Promise<Record<string, { used: number; limit: number; remaining: number; resetAt: Date }>> {
    const { yyyymmdd, resetAt } = this.getUtcDayBounds(now);
    const result: Record<string, { used: number; limit: number; remaining: number; resetAt: Date }> = {};

    if (!isRedisConfigured()) {
      for (const feature of features) {
        const limit = this.getLimit(feature);
        result[feature] = { used: 0, limit, remaining: limit, resetAt };
      }
      return result;
    }

    const redis = getRedisClient();
    for (const feature of features) {
      const limit = this.getLimit(feature);
      const key = this.getQuotaKey(userId, feature, yyyymmdd);
      try {
        const val = await redis.get(key);
        const used = val ? parseInt(val, 10) : 0;
        result[feature] = {
          used,
          limit,
          remaining: Math.max(0, limit - used),
          resetAt,
        };
      } catch {
        result[feature] = { used: 0, limit, remaining: limit, resetAt };
      }
    }

    return result;
  }

  /**
   * Gives back a unit taken by checkAndConsumeQuota when the request ended without a
   * provider answer (e.g. the heuristic fallback ran). Pass the same `now` that was used
   * to consume so the refund lands on the same day's counter. Never throws.
   */
  async refundQuota(userId: string, feature: string = 'default', now: Date = new Date()): Promise<void> {
    if (!isRedisConfigured()) return;
    const { yyyymmdd } = this.getUtcDayBounds(now);
    const key = this.getQuotaKey(userId, feature, yyyymmdd);

    try {
      await getRedisClient().eval(REFUND_QUOTA_SCRIPT, 1, key);
    } catch (err) {
      logger.warn('[QuotaService] Redis quota refund failed', {
        userId,
        feature,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resets quota counters for a user (primarily for testing and administration).
   */
  async resetQuota(userId: string, feature?: string, now: Date = new Date()): Promise<void> {
    if (!isRedisConfigured()) return;
    const { yyyymmdd } = this.getUtcDayBounds(now);
    const redis = getRedisClient();

    if (feature) {
      const key = this.getQuotaKey(userId, feature, yyyymmdd);
      await redis.del(key);
    } else {
      const pattern = `devtrack:ai:quota:${userId}:*:${yyyymmdd}`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  }
}

export const quotaService = new QuotaService();
