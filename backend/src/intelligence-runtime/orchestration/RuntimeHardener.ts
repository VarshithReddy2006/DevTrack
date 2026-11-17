import { logger } from '../../shared/logger.js';
import { metricsTracker } from '../observability/MetricsTracker.js';

export class RuntimeHardener {
  private readonly GEMINI_QUOTA_LIMIT = 50; // calls per minute mock
  private currentGeminiCalls = 0;
  
  private lastInterventionTimestamp: Record<string, number> = {};
  private readonly INTERVENTION_COOLDOWN_MS = 86400000; // 24 hours

  /**
   * Evaluates if we should gracefully degrade AI features
   * due to API quotas or latency spikes.
   */
  canUseGemini(): boolean {
    if (this.currentGeminiCalls >= this.GEMINI_QUOTA_LIMIT) {
      metricsTracker.recordFailure('gemini', 'quota_exceeded');
      logger.warn('[RuntimeHardener] Gemini quota exceeded. Failing over to deterministic-only pipeline.');
      return false; // Force graceful degradation
    }
    
    this.currentGeminiCalls++;
    // Mock quota reset logic
    setTimeout(() => this.currentGeminiCalls--, 60000); 
    
    return true;
  }

  /**
   * Safely wraps a critical worker execution block to isolate crashes.
   */
  async isolateCrash<T>(workerName: string, executionBlock: () => Promise<T>): Promise<T | null> {
    try {
      return await executionBlock();
    } catch (error: any) {
      metricsTracker.recordFailure('worker', `${workerName}_crash`);
      logger.error('[RuntimeHardener] Worker crashed, isolating failure', error, { workerName });
      return null;
    }
  }

  /**
   * Prevents rapid-fire pacing or roadmap interventions to avoid user thrashing.
   */
  shouldThrottleIntervention(userId: string): boolean {
    const now = Date.now();
    const last = this.lastInterventionTimestamp[userId] || 0;

    if (now - last < this.INTERVENTION_COOLDOWN_MS) {
      logger.warn(`[RuntimeHardener] Intervention throttled for user ${userId}. Cooldown active.`);
      return true;
    }

    this.lastInterventionTimestamp[userId] = now;
    return false;
  }

  /**
   * Rolls back an optimization if it resulted in severe negative causal outcomes.
   */
  evaluateOptimizationRollback(userId: string, impactScore: number): boolean {
    if (impactScore < 0.1) {
      logger.error(`[RuntimeHardener] Severe negative outcome detected for user ${userId}. Reverting to foundational baseline.`);
      return true; // Signal to revert
    }
    return false;
  }

  /**
   * Enforces queue backpressure when the system is under heavy load.
   */
  shouldApplyBackpressure(queueDepth: number, threshold: number = 1000): boolean {
    if (queueDepth >= threshold) {
      metricsTracker.recordFailure('queue', 'backpressure_applied');
      logger.warn(`[RuntimeHardener] Queue depth ${queueDepth} exceeds threshold ${threshold}. Applying backpressure.`);
      return true;
    }
    return false;
  }

  /**
   * Prevents OOM errors by aggressively tracking heap usage during ingestion.
   */
  enforceMemorySafeguards(maxHeapLimitMB: number = 1024): boolean {
    const memoryUsage = process.memoryUsage();
    const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;
    
    if (heapUsedMB > maxHeapLimitMB) {
      logger.error(`[RuntimeHardener] Memory threshold exceeded: ${heapUsedMB.toFixed(2)}MB. Halting ingest pipeline temporarily.`);
      metricsTracker.recordFailure('worker', 'memory_safeguard_triggered');
      return true;
    }
    return false;
  }
}
