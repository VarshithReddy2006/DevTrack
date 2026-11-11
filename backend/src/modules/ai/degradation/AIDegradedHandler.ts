import { AIProviderAdapter } from '../provider/AIProviderAdapter.js';
import { logger } from '../../../shared/logger.js';

export interface DegradationStatus {
  aiEnabled: boolean;
  degradationLevel: 'none' | 'partial' | 'full';
  activeProvider: string;
  fallbackTriggered: boolean;
  lastFailure: Date | null;
  failureCount: number;
  estimatedRecoveryTime: Date | null;
}

export interface DegradationConfig {
  maxFailures: number;
  failureWindow: number; // minutes
  autoRecoveryAttempts: number;
  recoveryInterval: number; // minutes
}

class AIDegradedHandlerClass {
  private degradationStatus: DegradationStatus = {
    aiEnabled: true,
    degradationLevel: 'none',
    activeProvider: 'openai',
    fallbackTriggered: false,
    lastFailure: null,
    failureCount: 0,
    estimatedRecoveryTime: null,
  };

  private config: DegradationConfig = {
    maxFailures: 5,
    failureWindow: 10,
    autoRecoveryAttempts: 3,
    recoveryInterval: 5,
  };

  private failureHistory: Array<{ timestamp: Date; provider: string; error: string }> = [];
  private recoveryAttempts: number = 0;
  private recoveryTimer: NodeJS.Timeout | null = null;

  /**
   * Handle AI provider failure
   */
  handleFailure(provider: string, error: string): void {
    const now = new Date();
    
    this.failureHistory.push({
      timestamp: now,
      provider,
      error,
    });

    // Keep only recent failures within window
    const windowStart = new Date(now.getTime() - this.config.failureWindow * 60 * 1000);
    this.failureHistory = this.failureHistory.filter(f => f.timestamp >= windowStart);

    this.degradationStatus.lastFailure = now;
    this.degradationStatus.failureCount = this.failureHistory.length;

    logger.warn('[AIDegradedHandler] AI provider failure detected', { 
      provider, 
      error, 
      failureCount: this.degradationStatus.failureCount 
    });

    // Check if we need to degrade
    this.checkDegradationThreshold();
  }

  /**
   * Check if degradation threshold is reached
   */
  private checkDegradationThreshold(): void {
    if (this.degradationStatus.failureCount >= this.config.maxFailures) {
      this.triggerFullDegradation();
    } else if (this.degradationStatus.failureCount >= this.config.maxFailures / 2) {
      this.triggerPartialDegradation();
    }
  }

  /**
   * Trigger partial degradation
   */
  private triggerPartialDegradation(): void {
    this.degradationStatus.degradationLevel = 'partial';
    this.degradationStatus.fallbackTriggered = true;
    
    logger.warn('[AIDegradedHandler] Partial degradation triggered', { 
      failureCount: this.degradationStatus.failureCount 
    });
  }

  /**
   * Trigger full degradation
   */
  private triggerFullDegradation(): void {
    this.degradationStatus.degradationLevel = 'full';
    this.degradationStatus.aiEnabled = false;
    this.degradationStatus.estimatedRecoveryTime = new Date(Date.now() + this.config.recoveryInterval * 60 * 1000);
    
    logger.error('[AIDegradedHandler] Full degradation triggered - AI disabled', { 
      failureCount: this.degradationStatus.failureCount 
    });

    // Start recovery timer
    this.startRecoveryTimer();
  }

  /**
   * Start recovery timer
   */
  private startRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
    }

    this.recoveryTimer = setTimeout(() => {
      this.attemptRecovery();
    }, this.config.recoveryInterval * 60 * 1000);

    logger.info('[AIDegradedHandler] Recovery timer started', { 
      interval: this.config.recoveryInterval 
    });
  }

  /**
   * Attempt recovery
   */
  private async attemptRecovery(): Promise<void> {
    if (this.recoveryAttempts >= this.config.autoRecoveryAttempts) {
      logger.error('[AIDegradedHandler] Max recovery attempts reached', { 
        attempts: this.recoveryAttempts 
      });
      return;
    }

    this.recoveryAttempts++;

    logger.info('[AIDegradedHandler] Attempting recovery', { 
      attempt: this.recoveryAttempts 
    });

    try {
      // Try a simple AI request to test provider health
      const testResponse = await AIProviderAdapter.generateResponse({
        prompt: 'test',
        cache: false,
        maxTokens: 10,
      });

      if (testResponse) {
        this.recoverFromDegradation();
      }
    } catch (error) {
      logger.warn('[AIDegradedHandler] Recovery attempt failed', { 
        attempt: this.recoveryAttempts,
        error 
      });

      // Schedule next recovery attempt
      this.startRecoveryTimer();
    }
  }

  /**
   * Recover from degradation
   */
  private recoverFromDegradation(): void {
    this.degradationStatus.aiEnabled = true;
    this.degradationStatus.degradationLevel = 'none';
    this.degradationStatus.failureCount = 0;
    this.degradationStatus.lastFailure = null;
    this.degradationStatus.estimatedRecoveryTime = null;
    this.recoveryAttempts = 0;
    this.failureHistory = [];

    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    logger.info('[AIDegradedHandler] Recovered from degradation');
  }

  /**
   * Manually enable AI
   */
  enableAI(): void {
    this.recoverFromDegradation();
    logger.info('[AIDegradedHandler] AI manually enabled');
  }

  /**
   * Manually disable AI
   */
  disableAI(): void {
    this.degradationStatus.aiEnabled = false;
    this.degradationStatus.degradationLevel = 'full';
    this.degradationStatus.estimatedRecoveryTime = null;

    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    logger.info('[AIDegradedHandler] AI manually disabled');
  }

  /**
   * Get degradation status
   */
  getStatus(): DegradationStatus {
    return { ...this.degradationStatus };
  }

  /**
   * Check if AI is available
   */
  isAIAvailable(): boolean {
    return this.degradationStatus.aiEnabled && this.degradationStatus.degradationLevel !== 'full';
  }

  /**
   * Check if AI is degraded
   */
  isAIDegraded(): boolean {
    return this.degradationStatus.degradationLevel !== 'none';
  }

  /**
   * Get degradation level
   */
  getDegradationLevel(): 'none' | 'partial' | 'full' {
    return this.degradationStatus.degradationLevel;
  }

  /**
   * Get failure history
   */
  getFailureHistory(limit: number = 10): Array<{ timestamp: Date; provider: string; error: string }> {
    return this.failureHistory.slice(-limit);
  }

  /**
   * Clear failure history
   */
  clearFailureHistory(): void {
    this.failureHistory = [];
    this.degradationStatus.failureCount = 0;
    logger.info('[AIDegradedHandler] Failure history cleared');
  }

  /**
   * Update degradation config
   */
  updateConfig(config: Partial<DegradationConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('[AIDegradedHandler] Config updated', { config });
  }

  /**
   * Get current config
   */
  getConfig(): DegradationConfig {
    return { ...this.config };
  }

  /**
   * Reset to initial state
   */
  reset(): void {
    this.degradationStatus = {
      aiEnabled: true,
      degradationLevel: 'none',
      activeProvider: 'openai',
      fallbackTriggered: false,
      lastFailure: null,
      failureCount: 0,
      estimatedRecoveryTime: null,
    };

    this.failureHistory = [];
    this.recoveryAttempts = 0;

    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    logger.info('[AIDegradedHandler] Reset to initial state');
  }

  /**
   * Get degraded response (fallback response when AI is unavailable)
   */
  getDegradedResponse(originalPrompt: string): string {
    if (this.degradationStatus.degradationLevel === 'full') {
      return 'AI services are currently unavailable due to provider issues. Deterministic readiness systems remain fully functional. Please try again later.';
    } else if (this.degradationStatus.degradationLevel === 'partial') {
      return 'AI services are currently operating in degraded mode. Some features may be limited. Deterministic readiness systems remain fully functional.';
    }

    return originalPrompt;
  }

  /**
   * Check if should use fallback
   */
  shouldUseFallback(): boolean {
    return !this.isAIAvailable();
  }

  /**
   * Get health summary
   */
  getHealthSummary(): {
    status: 'healthy' | 'degraded' | 'down';
    aiEnabled: boolean;
    degradationLevel: string;
    failureCount: number;
    estimatedRecoveryTime: Date | null;
  } {
    let status: 'healthy' | 'degraded' | 'down' = 'healthy';

    if (!this.degradationStatus.aiEnabled) {
      status = 'down';
    } else if (this.degradationStatus.degradationLevel !== 'none') {
      status = 'degraded';
    }

    return {
      status,
      aiEnabled: this.degradationStatus.aiEnabled,
      degradationLevel: this.degradationStatus.degradationLevel,
      failureCount: this.degradationStatus.failureCount,
      estimatedRecoveryTime: this.degradationStatus.estimatedRecoveryTime,
    };
  }
}

export const AIDegradedHandler = new AIDegradedHandlerClass();
