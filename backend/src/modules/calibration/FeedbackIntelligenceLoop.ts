// src/modules/calibration/FeedbackIntelligenceLoop.ts
// Handles real-world developer and recruiter corrections, mismatch logs, and feedback loops to calibrate engines.

import { FeedbackReportModel } from '../../db/models/feedbackReport.model.js';
import { logger } from '../../shared/logger.js';
import { getRedisClient, isRedisConfigured } from '../../shared/redis/client.js';
import { isSentinelConfigured } from '../../shared/redis/sentinelClient.js';

export interface FeedbackReport {
  reportId: string;
  userId: string;
  source: 'developer' | 'recruiter' | 'admin';
  category: 'onboarding' | 'recommendation' | 'ats' | 'semantic_mismatch' | 'credibility';
  mismatchDetails: {
    expectedValue: unknown;
    systemValue: unknown;
    reasoning: string;
  };
  context?: Record<string, unknown>;
  timestamp: Date;
}

const CATEGORIES: FeedbackReport['category'][] = ['onboarding', 'recommendation', 'ats', 'semantic_mismatch', 'credibility'];
const CALIBRATION_THRESHOLD = 10;
const LOCK_TTL_MS = 5000;
// Retries cover a full lock TTL, so a lock left behind by a dead worker still gets cleared.
const LOCK_RETRY_DELAY_MS = 1000;
const LOCK_MAX_RETRIES = 10;
// Commands queue indefinitely while ioredis reconnects, so callers must not wait on them forever.
const REDIS_TIMEOUT_MS = 2000;

const counterKey = (category: string) => `calibration:mismatches:${category}`;
const lastCountKey = (category: string) => `calibration:last_count:${category}`;

type RedisClient = ReturnType<typeof getRedisClient>;

/** The Redis client, or null when Redis is unconfigured or not currently connected. */
function getAvailableRedis(): RedisClient | null {
  if (!isRedisConfigured() && !isSentinelConfigured()) return null;
  try {
    const redis = getRedisClient();
    return redis.status && redis.status !== 'ready' ? null : redis;
  } catch (err) {
    logger.warn('[FeedbackLoop] Could not get a Redis client', { error: err });
    return null;
  }
}

async function withRedisTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis did not respond within ${REDIS_TIMEOUT_MS}ms`)), REDIS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mismatch count covered by the last calibration. If the key is gone (eviction), assume every
 * block before the one ending at `count` was already calibrated rather than replaying history.
 * A stored value above `count` means the counter was reset, so nothing in it is covered yet.
 */
async function readLastCalibratedCount(redis: RedisClient, category: string, count: number): Promise<number> {
  const stored = parseInt((await redis.get(lastCountKey(category))) ?? '', 10);
  if (!Number.isNaN(stored)) return stored <= count ? stored : 0;
  return Math.max(0, Math.floor((count - 1) / CALIBRATION_THRESHOLD) * CALIBRATION_THRESHOLD);
}

export class FeedbackIntelligenceLoop {
  private static pendingRetries = new Set<string>();

  /**
   * Log developer or recruiter mismatch correction feedback.
   * Persists to MongoDB, buffers in bounded Redis list, and triggers guarded recalibration.
   */
  static async submitFeedback(report: FeedbackReport): Promise<void> {
    // 1. Persist report to MongoDB
    await FeedbackReportModel.create({
      reportId: report.reportId,
      userId: report.userId,
      source: report.source,
      category: report.category,
      mismatchDetails: report.mismatchDetails,
      context: report.context,
      timestamp: report.timestamp ?? new Date(),
    });

    logger.info(`[FeedbackLoop] Received feedback in ${report.category} from ${report.source} regarding ${report.reportId}`);

    // 2. Redis buffering and calibration are best effort: the report is already persisted
    const redis = getAvailableRedis();
    if (!redis) {
      logger.warn(`[FeedbackLoop] Redis unavailable. Skipping buffering and calibration for ${report.reportId}`);
      return;
    }

    try {
      await withRedisTimeout(this.bufferAndCalibrate(redis, report));
    } catch (err) {
      logger.warn(`[FeedbackLoop] Redis buffering or calibration failed for ${report.reportId}`, { error: err });
    }
  }

  private static async bufferAndCalibrate(redis: RedisClient, report: FeedbackReport): Promise<void> {
    // Buffer in Redis list and bound to latest 500 reports to prevent memory leaks
    const listKey = `calibration:feedback:list`;

    await redis.lpush(listKey, JSON.stringify(report));
    if (typeof (redis as any).ltrim === 'function') {
      await redis.ltrim(listKey, 0, 499);
    }
    if (typeof (redis as any).expire === 'function') {
      await redis.expire(listKey, 30 * 24 * 3600); // 30-day retention
    }

    // Seed the calibrated count from the counter before this report is added to it. Counters
    // that predate this key then continue from their last full block of 10.
    if ((await redis.get(lastCountKey(report.category))) == null) {
      const previous = parseInt((await redis.get(counterKey(report.category))) || '0', 10);
      await redis.set(lastCountKey(report.category), String(previous - (previous % CALIBRATION_THRESHOLD)), 'NX');
    }

    // Atomically increment mismatch counter (with fallback for test mocks)
    const incrResult = await redis.incr(counterKey(report.category));
    let mismatchCount: number;
    if (typeof incrResult === 'number' && !isNaN(incrResult)) {
      mismatchCount = incrResult;
    } else {
      const rawCount = await redis.get(counterKey(report.category));
      mismatchCount = parseInt(rawCount || '0', 10);
    }

    // Trigger recalibration once 10 or more mismatches are waiting to be applied
    const lastCalibrated = await readLastCalibratedCount(redis, report.category, mismatchCount);
    if (mismatchCount - lastCalibrated >= CALIBRATION_THRESHOLD) {
      logger.info(`[FeedbackLoop] Multi-mismatch threshold reached for ${report.category} (${mismatchCount} entries). Initiating automatic weights recalibration.`);
      await this.runAutomaticCalibration(redis, report.category);
    }
  }

  /**
   * Dynamic weight recalibration loop driven by user/recruiter feedback corrections.
   * Protected by a Redis distributed lock (with TTL) to serialize concurrent recalibrations.
   * Applies one step for every full block of 10 mismatches not yet calibrated.
   */
  private static async runAutomaticCalibration(redis: RedisClient, category: string, attempt = 0): Promise<void> {
    const lockKey = `calibration:lock:${category}`;
    const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;

    // Acquire distributed lock: set NX with PX expiration
    const acquired = await redis.set(lockKey, lockToken, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired !== 'OK') {
      logger.info(`[FeedbackLoop] Calibration lock for ${category} is held by another worker. Retrying later.`);
      this.scheduleRetry(category, attempt + 1);
      return;
    }

    try {
      const calibrationKey = `calibration:weights:${category}`;

      // Check again under the lock: another worker may have covered these mismatches already
      const count = parseInt((await redis.get(counterKey(category))) || '0', 10);
      const lastCalibrated = await readLastCalibratedCount(redis, category, count);
      const cycles = Math.floor((count - lastCalibrated) / CALIBRATION_THRESHOLD);
      if (cycles < 1) return;

      // Read current calibration factor
      const rawVal = await redis.get(calibrationKey);
      let calibrationFactor = parseFloat(rawVal || '1.0');

      for (let cycle = 0; cycle < cycles; cycle++) {
        calibrationFactor = this.adjustFactor(category, calibrationFactor);
      }

      // Format to avoid floating point precision quirks (e.g., 0.7999999999999999)
      const cleanedFactor = parseFloat(calibrationFactor.toFixed(4));
      // One command, so the weight and the count it covers can never get out of step
      await redis.mset(
        calibrationKey,
        cleanedFactor.toString(),
        lastCountKey(category),
        String(lastCalibrated + cycles * CALIBRATION_THRESHOLD),
      );
      logger.info(`[FeedbackLoop] Calibrated ${category} factor to ${cleanedFactor} (${cycles} cycle(s))`);
    } finally {
      // Safely release lock only if the token matches (using atomic Lua script)
      const releaseLockScript = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      try {
        await redis.eval(releaseLockScript, 1, lockKey, lockToken);
      } catch (err) {
        logger.warn(`[FeedbackLoop] Failed to release calibration lock for ${category}`, { error: err });
      }
    }
  }

  /**
   * Come back to a contended calibration once the lock has had time to clear. The pending
   * mismatches stay recorded in Redis, so a later submission also picks them up.
   */
  private static scheduleRetry(category: string, attempt: number): void {
    if (attempt > LOCK_MAX_RETRIES || this.pendingRetries.has(category)) return;
    this.pendingRetries.add(category);

    setTimeout(() => {
      this.pendingRetries.delete(category);
      const redis = getAvailableRedis();
      if (!redis) {
        this.scheduleRetry(category, attempt + 1);
        return;
      }
      this.runAutomaticCalibration(redis, category, attempt).catch((err) => {
        logger.warn(`[FeedbackLoop] Calibration retry failed for ${category}`, { error: err });
        this.scheduleRetry(category, attempt + 1);
      });
    }, LOCK_RETRY_DELAY_MS).unref();
  }

  private static adjustFactor(category: string, factor: number): number {
    // Refine weighting factor based on mismatch statistics
    if (category === 'semantic_mismatch') {
      // Recruiter reported mismatch - reduce cosine threshold slightly to widen relevant pool
      return Math.max(0.65, factor - 0.05);
    }
    if (category === 'ats') {
      // Developer reported parser issues - tighten strictness factor
      return Math.min(1.2, factor + 0.05);
    }
    if (category === 'recommendation') {
      // Noise reported - reduce frequency decay index
      return Math.max(0.5, factor - 0.1);
    }
    return factor;
  }

  /**
   * Fetch all calibration correction logs for diagnostic audit.
   * Falls back to counting persisted reports in MongoDB when Redis cannot answer.
   */
  static async getFeedbackStats(): Promise<Record<string, number>> {
    const redis = getAvailableRedis();
    if (redis) {
      try {
        const values = await withRedisTimeout(Promise.all(CATEGORIES.map((cat) => redis.get(counterKey(cat)))));
        return Object.fromEntries(CATEGORIES.map((cat, i) => [cat, parseInt(values[i] || '0', 10)]));
      } catch (err) {
        logger.warn('[FeedbackLoop] Failed to read feedback counters from Redis. Counting from MongoDB.', { error: err });
      }
    } else {
      logger.warn('[FeedbackLoop] Redis unavailable. Counting feedback stats from MongoDB.');
    }

    const grouped = await FeedbackReportModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);
    const counts = new Map(grouped.map((row) => [row._id, row.count]));
    return Object.fromEntries(CATEGORIES.map((cat) => [cat, counts.get(cat) ?? 0]));
  }

  /**
   * Fetch persisted feedback reports from MongoDB for audit or review
   */
  static async getReports(query?: { category?: string; userId?: string; limit?: number }) {
    const filter: Record<string, unknown> = {};
    if (query?.category) filter.category = query.category;
    if (query?.userId) filter.userId = query.userId;
    return FeedbackReportModel.find(filter)
      .sort({ timestamp: -1 })
      .limit(query?.limit ?? 50)
      .lean();
  }
}
