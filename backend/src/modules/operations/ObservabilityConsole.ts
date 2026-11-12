import { ProviderHealthRegistry } from '../readiness/provider/ProviderHealthRegistry.js';
import { getQueue, getAllQueues } from '../../shared/jobs/queueFactory.js';
import { SnapshotVersioningSystem } from './SnapshotVersioningSystem.js';
import { EvidenceChainSystem } from './EvidenceChainSystem.js';
import { RecommendationStabilityTests, TestSuite } from '../readiness/testing/RecommendationStabilityTests.js';
import { AIProviderAdapter } from '../ai/provider/AIProviderAdapter.js';
import { AIResponseAuditLog } from '../ai/audit/AIResponseAuditLog.js';
import { RecommendationMemory } from '../readiness/recommendation/RecommendationMemory.js';
import { RecommendationLifecycleEngine } from '../readiness/recommendation/RecommendationLifecycleEngine.js';
import { ReadinessOrchestratorService } from '../readiness/engine/ReadinessOrchestratorService.js';
import { logger } from '../../shared/logger.js';

export interface SystemHealth {
  overallStatus: 'healthy' | 'degraded' | 'critical';
  providerHealth: {
    totalProviders: number;
    healthyCount: number;
    degradedCount: number;
    downCount: number;
    degradedModeCount: number;
    providers: any[];
  };
  queueHealth: {
    totalQueues: number;
    queues: any[];
  };
  systemMetrics: {
    totalSnapshots: number;
    totalEvidenceChains: number;
    averageConfidence: number;
  };
  lastHealthCheck: Date;
}

export interface RecommendationMetrics {
  totalRecommendations: number;
  acceptanceRate: number;
  completionRate: number;
  averageEffectiveness: number;
  averageTimeToComplete: number;
  staleRecommendations: number;
  decayedRecommendations: number;
  byType: Record<string, {
    total: number;
    accepted: number;
    completed: number;
    effectiveness: number;
  }>;
  orchestrationFailures: number;
  roadmapBlockerFrequency: number;
  momentumAnomalies: number;
}

export interface AIMetrics {
  providerHealth: any[];
  tokenUsageStats: {
    totalTokens: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
  };
  auditStats: {
    totalRequests: number;
    averageLatency: number;
    cacheHitRate: number;
    moderationFlagCount: number;
    hallucinationFlagCount: number;
    safetyViolationCount: number;
    failureCount: number;
  };
  currentProvider: string;
  degradedProviders: string[];
}

export interface ObservabilityMetrics {
  systemHealth: SystemHealth;
  aggregationMetrics: {
    totalAggregations: number;
    successRate: number;
    averageDuration: number;
  };
  errorMetrics: {
    totalErrors: number;
    recentErrors: any[];
    errorRate: number;
  };
  performanceMetrics: {
    averageResponseTime: number;
    p95ResponseTime: number;
    p99ResponseTime: number;
  };
  recommendationMetrics: RecommendationMetrics;
  aiMetrics: AIMetrics;
}

class ObservabilityConsoleClass {
  private errorLog: any[] = [];
  private aggregationMetrics: Map<string, { startTime: number; duration: number; success: boolean }> = new Map();
  private responseTimes: number[] = [];

  /**
   * Get comprehensive system health status
   */
  async getSystemHealth(): Promise<SystemHealth> {
    const providerHealthSummary = ProviderHealthRegistry.getHealthSummary();
    const degradedProviders = ProviderHealthRegistry.getDegradedProviders();
    const allProviders = ProviderHealthRegistry.getAllProviderHealth();
    
    // Get queue health (if queues are initialized)
    let queueHealth = {
      totalQueues: 0,
      queues: [] as any[],
    };
    
    try {
      // Get stats for all registered queues from the factory
      const queues = getAllQueues();
      for (const queue of queues) {
        try {
          const [waiting, active, completed, failed, delayed] = await Promise.all([
            queue.getWaitingCount(),
            queue.getActiveCount(),
            queue.getCompletedCount(),
            queue.getFailedCount(),
            queue.getDelayedCount(),
          ]);

          queueHealth.queues.push({
            queueName: queue.name,
            waiting,
            active,
            completed,
            failed,
            delayed,
          });
        } catch (error) {
          // Individual queue stats might fail
        }
      }
      queueHealth.totalQueues = queueHealth.queues.length;
    } catch (error) {
      // Error accessing queues
    }

    // Get system metrics
    const snapshotStats = SnapshotVersioningSystem.getStats();
    const evidenceStats = EvidenceChainSystem.getStats();
    
    // Determine overall status
    let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (providerHealthSummary.downCount > 0) {
      overallStatus = 'critical';
    } else if (providerHealthSummary.degradedCount > 0 || providerHealthSummary.degradedModeCount > 0) {
      overallStatus = 'degraded';
    }

    return {
      overallStatus,
      providerHealth: {
        ...providerHealthSummary,
        providers: allProviders,
      },
      queueHealth,
      systemMetrics: {
        totalSnapshots: snapshotStats.totalSnapshots,
        totalEvidenceChains: evidenceStats.totalChains,
        averageConfidence: evidenceStats.averageChainSize, // Using chain size as proxy
      },
      lastHealthCheck: new Date(),
    };
  }

  /**
   * Get comprehensive observability metrics
   */
  async getObservabilityMetrics(): Promise<ObservabilityMetrics> {
    const systemHealth = await this.getSystemHealth();
    
    // Calculate aggregation metrics
    const aggregations = Array.from(this.aggregationMetrics.values());
    const successRate = aggregations.length > 0
      ? aggregations.filter(a => a.success).length / aggregations.length
      : 1;
    const averageDuration = aggregations.length > 0
      ? aggregations.reduce((sum, a) => sum + a.duration, 0) / aggregations.length
      : 0;

    // Calculate error metrics
    const recentErrors = this.errorLog.slice(-10);
    const errorRate = aggregations.length > 0
      ? aggregations.filter(a => !a.success).length / aggregations.length
      : 0;

    // Calculate performance metrics
    const sortedResponseTimes = [...this.responseTimes].sort((a, b) => a - b);
    const averageResponseTime = sortedResponseTimes.length > 0
      ? sortedResponseTimes.reduce((sum, t) => sum + t, 0) / sortedResponseTimes.length
      : 0;
    const p95Index = Math.floor(sortedResponseTimes.length * 0.95);
    const p95ResponseTime = sortedResponseTimes.length > 0 ? sortedResponseTimes[p95Index] || 0 : 0;
    const p99Index = Math.floor(sortedResponseTimes.length * 0.99);
    const p99ResponseTime = sortedResponseTimes.length > 0 ? sortedResponseTimes[p99Index] || 0 : 0;

    // Calculate recommendation metrics
    const recommendationMetrics = this.calculateRecommendationMetrics();

    // Calculate AI metrics
    const aiMetrics = await this.calculateAIMetrics();

    return {
      systemHealth,
      aggregationMetrics: {
        totalAggregations: aggregations.length,
        successRate,
        averageDuration,
      },
      errorMetrics: {
        totalErrors: this.errorLog.length,
        recentErrors,
        errorRate,
      },
      performanceMetrics: {
        averageResponseTime,
        p95ResponseTime,
        p99ResponseTime,
      },
      recommendationMetrics,
      aiMetrics,
    };
  }

  /**
   * Calculate AI metrics
   */
  private async calculateAIMetrics(): Promise<AIMetrics> {
    const providerHealth = AIProviderAdapter.getAllProviderHealth();
    const tokenUsageStats = AIProviderAdapter.getTokenUsageStats();
    const auditStats = await AIResponseAuditLog.calculateStats();
    const currentProvider = AIProviderAdapter.getCurrentProvider();
    const degradedProviders = providerHealth
      .filter(p => p.status !== 'healthy')
      .map(p => p.provider);

    return {
      providerHealth,
      tokenUsageStats,
      auditStats: {
        totalRequests: auditStats.totalRequests,
        averageLatency: auditStats.averageLatency,
        cacheHitRate: auditStats.cacheHitRate,
        moderationFlagCount: auditStats.moderationFlagCount,
        hallucinationFlagCount: auditStats.hallucinationFlagCount,
        safetyViolationCount: auditStats.safetyViolationCount,
        failureCount: auditStats.failureCount,
      },
      currentProvider,
      degradedProviders,
    };
  }

  /**
   * Calculate recommendation metrics
   */
  private calculateRecommendationMetrics(): RecommendationMetrics {
    const memoryStats = RecommendationMemory.getStats();
    // Get global lifecycle metrics (no userId needed)
    const allLifecycles = Array.from((RecommendationLifecycleEngine as any).lifecycles.values()) as any[];
    const totalRecommendations = allLifecycles.length;
    const completedCount = allLifecycles.filter((l: any) => l.state === 'completed').length;
    const acceptanceRate = totalRecommendations > 0 ? (allLifecycles.filter((l: any) => l.state === 'accepted' || l.state === 'completed').length / totalRecommendations) * 100 : 0;
    const completionRate = totalRecommendations > 0 ? (completedCount / totalRecommendations) * 100 : 0;
    
    const effectivenessScores = allLifecycles.filter((l: any) => l.effectivenessScore !== undefined).map((l: any) => l.effectivenessScore);
    const averageEffectiveness = effectivenessScores.length > 0 ? effectivenessScores.reduce((sum: number, s: number) => sum + s, 0) / effectivenessScores.length : 0;
    
    const timeToComplete = allLifecycles.filter((l: any) => l.timeToComplete).map((l: any) => l.timeToComplete);
    const averageTimeToComplete = timeToComplete.length > 0 ? timeToComplete.reduce((sum: number, t: number) => sum + t, 0) / timeToComplete.length : 0;
    
    const decayedCount = allLifecycles.filter((l: any) => l.state === 'decayed').length;
    
    // Calculate by type metrics
    const byType: Record<string, { total: number; accepted: number; completed: number; effectiveness: number }> = {};
    allLifecycles.forEach((l: any) => {
      if (!byType[l.type]) {
        byType[l.type] = { total: 0, accepted: 0, completed: 0, effectiveness: 0 };
      }
      byType[l.type].total++;
      if (l.state === 'accepted' || l.state === 'completed') byType[l.type].accepted++;
      if (l.state === 'completed') byType[l.type].completed++;
      if (l.effectivenessScore !== undefined) byType[l.type].effectiveness += l.effectivenessScore;
    });
    
    // Calculate average effectiveness by type
    Object.keys(byType).forEach(type => {
      const completed = byType[type].completed;
      if (completed > 0) {
        byType[type].effectiveness = byType[type].effectiveness / completed;
      }
    });
    
    // Orchestration failures are tracked via logs in the engine version
    const orchestrationFailures = 0; 
    
    // Calculate roadmap blocker frequency (mock - would come from actual data)
    const roadmapBlockerFrequency = 0; // Would be calculated from DynamicRoadmapExperience
    
    // Calculate momentum anomalies (mock - would come from actual data)
    const momentumAnomalies = 0; // Would be calculated from ReadinessMomentumEngine

    return {
      totalRecommendations: memoryStats.totalRecommendations,
      acceptanceRate: Math.round(acceptanceRate),
      completionRate: Math.round(completionRate),
      averageEffectiveness: Math.round(averageEffectiveness),
      averageTimeToComplete: Math.round(averageTimeToComplete),
      staleRecommendations: memoryStats.averageAge > 24 ? memoryStats.totalRecommendations : 0,
      decayedRecommendations: decayedCount,
      byType,
      orchestrationFailures,
      roadmapBlockerFrequency,
      momentumAnomalies,
    };
  }

  /**
   * Log an error
   */
  logError(error: any, context?: any): void {
    const errorEntry = {
      timestamp: new Date(),
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      context,
    };
    
    this.errorLog.push(errorEntry);
    
    // Keep only last 100 errors
    if (this.errorLog.length > 100) {
      this.errorLog = this.errorLog.slice(-100);
    }
    
    logger.error('[ObservabilityConsole] Error logged', errorEntry);
  }

  /**
   * Record aggregation metrics
   */
  recordAggregation(aggregationId: string, startTime: number, success: boolean): void {
    const duration = Date.now() - startTime;
    
    this.aggregationMetrics.set(aggregationId, {
      startTime,
      duration,
      success,
    });
    
    // Keep only last 1000 aggregations
    if (this.aggregationMetrics.size > 1000) {
      const oldestKey = this.aggregationMetrics.keys().next().value;
      if (oldestKey) {
        this.aggregationMetrics.delete(oldestKey);
      }
    }
    
    logger.info('[ObservabilityConsole] Aggregation recorded', { aggregationId, duration, success });
  }

  /**
   * Record response time
   */
  recordResponseTime(responseTime: number): void {
    this.responseTimes.push(responseTime);
    
    // Keep only last 1000 response times
    if (this.responseTimes.length > 1000) {
      this.responseTimes = this.responseTimes.slice(-1000);
    }
  }

  /**
   * Run system diagnostics
   */
  async runDiagnostics(): Promise<{
    healthCheck: SystemHealth;
    testResults: any;
    recommendations: string[];
  }> {
    logger.info('[ObservabilityConsole] Running system diagnostics');
    
    const healthCheck = await this.getSystemHealth();
    const testResults = await RecommendationStabilityTests.runAllTests();
    const recommendations: string[] = [];
    
    // Generate recommendations based on health and test results
    if (healthCheck.providerHealth.downCount > 0) {
      recommendations.push('Critical: One or more providers are down. Check provider health immediately.');
    }
    
    if (healthCheck.providerHealth.degradedCount > 0) {
      recommendations.push('Warning: Some providers are in degraded mode. Monitor closely.');
    }
    
    const totalTestFailures = testResults.reduce((sum: number, suite: TestSuite) => sum + suite.failedCount, 0);
    if (totalTestFailures > 0) {
      recommendations.push(`Warning: ${totalTestFailures} tests failed. Review test results.`);
    }
    
    if (healthCheck.queueHealth.totalQueues > 0) {
      const totalFailedJobs = healthCheck.queueHealth.queues.reduce((sum, q) => sum + (q.failed || 0), 0);
      if (totalFailedJobs > 10) {
        recommendations.push('Warning: High number of failed jobs in queues. Investigate.');
      }
    }
    
    if (recommendations.length === 0) {
      recommendations.push('System is healthy. No immediate action required.');
    }
    
    return {
      healthCheck,
      testResults,
      recommendations,
    };
  }

  /**
   * Get dashboard data for operations console
   */
  async getDashboardData(): Promise<{
    systemHealth: SystemHealth;
    metrics: ObservabilityMetrics;
    recentActivity: any[];
    alerts: any[];
  }> {
    const systemHealth = await this.getSystemHealth();
    const metrics = await this.getObservabilityMetrics();
    
    // Generate recent activity
    const recentActivity = [
      ...this.errorLog.slice(-5).map(e => ({
        type: 'error',
        message: e.message,
        timestamp: e.timestamp,
      })),
      {
        type: 'health_check',
        message: `System status: ${systemHealth.overallStatus}`,
        timestamp: systemHealth.lastHealthCheck,
      },
    ];
    
    // Generate alerts
    const alerts: any[] = [];
    
    if (systemHealth.providerHealth.downCount > 0) {
      alerts.push({
        severity: 'critical',
        message: `${systemHealth.providerHealth.downCount} provider(s) are down`,
        timestamp: new Date(),
      });
    }
    
    if (systemHealth.providerHealth.degradedCount > 0) {
      alerts.push({
        severity: 'warning',
        message: `${systemHealth.providerHealth.degradedCount} provider(s) are degraded`,
        timestamp: new Date(),
      });
    }
    
    if (metrics.errorMetrics.errorRate > 0.1) {
      alerts.push({
        severity: 'warning',
        message: `High error rate: ${(metrics.errorMetrics.errorRate * 100).toFixed(2)}%`,
        timestamp: new Date(),
      });
    }
    
    return {
      systemHealth,
      metrics,
      recentActivity,
      alerts,
    };
  }

  /**
   * Clear metrics (for testing)
   */
  clearMetrics(): void {
    this.errorLog = [];
    this.aggregationMetrics.clear();
    this.responseTimes = [];
    logger.info('[ObservabilityConsole] Metrics cleared');
  }
}

export const ObservabilityConsole = new ObservabilityConsoleClass();
