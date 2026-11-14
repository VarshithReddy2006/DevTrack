// src/modules/calibration/FeedbackIntelligenceLoop.ts
// Handles real-world developer and recruiter corrections, mismatch logs, and feedback loops to calibrate engines.

import { FeedbackReportModel } from '../../db/models/feedbackReport.model.js';
import { logger } from '../../shared/logger.js';
import { getRedisClient } from '../../shared/redis/client.js';

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

export class FeedbackIntelligenceLoop {
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

    // 2. Buffer in Redis list and bound to latest 500 reports to prevent memory leaks
    const redis = getRedisClient();
    const listKey = `calibration:feedback:list`;
    const counterKey = `calibration:mismatches:${report.category}`;

    await redis.lpush(listKey, JSON.stringify(report));
    await redis.ltrim(listKey, 0, 499);
    await redis.expire(listKey, 30 * 24 * 3600); // 30-day retention

    // 3. Atomically increment mismatch counter
    const mismatchCount = await redis.incr(counterKey);

    logger.info(`[FeedbackLoop] Received feedback in ${report.category} from ${report.source} regarding ${report.reportId}`);

    // 4. Trigger dynamic recalibration on every 10th mismatch
    if (mismatchCount % 10 === 0) {
      logger.info(`[FeedbackLoop] Multi-mismatch threshold reached for ${report.category} (${mismatchCount} entries). Initiating automatic weights recalibration.`);
      await this.runAutomaticCalibration(report.category);
    }
  }

  /**
   * Dynamic weight recalibration loop driven by user/recruiter feedback corrections.
   * Protected by a Redis distributed lock (with TTL) to serialize concurrent recalibrations.
   */
  private static async runAutomaticCalibration(category: string): Promise<void> {
    const redis = getRedisClient();
    const lockKey = `calibration:lock:${category}`;
    const lockToken = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
    const lockTtlMs = 5000;

    // Acquire distributed lock: set NX with PX expiration
    const acquired = await redis.set(lockKey, lockToken, 'PX', lockTtlMs, 'NX');
    if (acquired !== 'OK') {
      logger.info(`[FeedbackLoop] Calibration lock for ${category} is held by another worker. Skipping concurrent recalibration.`);
      return;
    }

    try {
      const calibrationKey = `calibration:weights:${category}`;

      // Read current calibration factor
      const rawVal = await redis.get(calibrationKey);
      let calibrationFactor = parseFloat(rawVal || '1.0');

      // Refine weighting factor based on mismatch statistics
      if (category === 'semantic_mismatch') {
        // Recruiter reported mismatch - reduce cosine threshold slightly to widen relevant pool
        calibrationFactor = Math.max(0.65, calibrationFactor - 0.05);
        logger.info(`[FeedbackLoop] Calibrated semantic cosine matching score threshold factor to: ${calibrationFactor}`);
      } else if (category === 'ats') {
        // Developer reported parser issues - tighten strictness factor
        calibrationFactor = Math.min(1.2, calibrationFactor + 0.05);
        logger.info(`[FeedbackLoop] Calibrated ATS parser weight multiplier factor to: ${calibrationFactor}`);
      } else if (category === 'recommendation') {
        // Noise reported - reduce frequency decay index
        calibrationFactor = Math.max(0.5, calibrationFactor - 0.1);
        logger.info(`[FeedbackLoop] Calibrated recommendation velocity index to: ${calibrationFactor}`);
      }

      // Format to avoid floating point precision quirks (e.g., 0.7999999999999999)
      const cleanedFactor = parseFloat(calibrationFactor.toFixed(4));
      await redis.set(calibrationKey, cleanedFactor.toString());
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
   * Fetch all calibration correction logs for diagnostic audit
   */
  static async getFeedbackStats(): Promise<Record<string, number>> {
    const redis = getRedisClient();
    const categories = ['onboarding', 'recommendation', 'ats', 'semantic_mismatch', 'credibility'];
    const stats: Record<string, number> = {};

    for (const cat of categories) {
      const val = await redis.get(`calibration:mismatches:${cat}`);
      stats[cat] = parseInt(val || '0', 10);
    }

    return stats;
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
