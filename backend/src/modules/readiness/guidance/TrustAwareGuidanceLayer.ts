import { Types } from 'mongoose';
import { ProviderHealthRegistry } from '../provider/ProviderHealthRegistry.js';
import { IntelligentRecommendationEngine } from '../recommendation/IntelligentRecommendationEngine.js';
import { ConnectedPlatform } from '../../../db/models/connectedPlatform.model.js';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { logger } from '../../../shared/logger.js';

export interface TrustAwareInput {
  userId: string;
  targetRole?: string;
  maxRecommendations?: number;
}

export interface TrustAwareGuidance {
  userId: string;
  recommendations: TrustAwareRecommendation[];
  trustFactors: TrustFactor[];
  overallTrustScore: number; // 0-100
  degradedModeActive: boolean;
  staleProviders: string[];
  warnings: TrustWarning[];
  timestamp: Date;
}

export interface TrustAwareRecommendation {
  recommendationId: string;
  title: string;
  description: string;
  originalConfidence: number;
  adjustedConfidence: number;
  trustAdjustments: TrustAdjustment[];
  isTrustReduced: boolean;
  trustReasoning: string;
  category: string;
  priority: string;
  estimatedEffort: string;
}

export interface TrustFactor {
  factor: string;
  value: number; // 0-100
  impact: 'high' | 'medium' | 'low';
  description: string;
}

export interface TrustAdjustment {
  factor: string;
  originalValue: number;
  adjustedValue: number;
  reason: string;
}

export interface TrustWarning {
  severity: 'critical' | 'warning' | 'info';
  message: string;
  context: string;
  actionable: boolean;
}

const benchmarkPlatforms = ['github', 'leetcode'] as const;
const benchmarkFreshnessMs = 24 * 60 * 60 * 1000;

class TrustAwareGuidanceLayerClass {
  /**
   * Generate trust-aware guidance
   */
  async generateTrustAwareGuidance(input: TrustAwareInput): Promise<TrustAwareGuidance> {
    const { userId, targetRole, maxRecommendations = 5 } = input;
    
    try {
      logger.info('[TrustAwareGuidanceLayer] Generating trust-aware guidance', { userId, targetRole });
      
      // Get provider health status
      const healthSummary = ProviderHealthRegistry.getHealthSummary();
      const degradedProviders = ProviderHealthRegistry.getDegradedProviders();
      
      // Get original recommendations
      const originalRecommendations = await IntelligentRecommendationEngine.generateRecommendations({
        userId,
        targetRole,
        maxRecommendations: maxRecommendations * 2, // Get more to filter after trust adjustment
      });
      
      // Calculate trust factors
      const trustFactors = await this.calculateTrustFactors(userId, healthSummary, degradedProviders);
      
      // Calculate overall trust score
      const overallTrustScore = this.calculateOverallTrustScore(trustFactors);
      
      // Adjust recommendations based on trust factors
      const adjustedRecommendations = this.adjustRecommendations(
        originalRecommendations,
        trustFactors,
        overallTrustScore
      );
      
      // Generate warnings
      const warnings = this.generateWarnings(trustFactors, degradedProviders);
      
      const guidance: TrustAwareGuidance = {
        userId,
        recommendations: adjustedRecommendations.slice(0, maxRecommendations),
        trustFactors,
        overallTrustScore,
        degradedModeActive: healthSummary.degradedModeCount > 0,
        staleProviders: degradedProviders.map(p => p.providerName),
        warnings,
        timestamp: new Date(),
      };
      
      logger.info('[TrustAwareGuidanceLayer] Trust-aware guidance generated', { 
        userId, 
        overallTrustScore,
        degradedModeActive: guidance.degradedModeActive 
      });
      
      return guidance;
    } catch (error) {
      logger.error('[TrustAwareGuidanceLayer] Failed to generate trust-aware guidance', { userId, error });
      throw error;
    }
  }

  /**
   * Calculate trust factors
   */
  private async calculateTrustFactors(
    userId: string,
    healthSummary: any,
    degradedProviders: any[]
  ): Promise<TrustFactor[]> {
    const factors: TrustFactor[] = [];
    
    // Provider health factor
    const providerHealthScore = this.calculateProviderHealthScore(healthSummary);
    factors.push({
      factor: 'provider-health',
      value: providerHealthScore,
      impact: providerHealthScore < 70 ? 'high' : 'medium',
      description: `Provider health: ${providerHealthScore}%`,
    });
    
    // Degraded mode factor
    const degradedModeScore = healthSummary.degradedModeCount > 0 ? 50 : 100;
    factors.push({
      factor: 'degraded-mode',
      value: degradedModeScore,
      impact: healthSummary.degradedModeCount > 0 ? 'high' : 'low',
      description: healthSummary.degradedModeCount > 0 
        ? `${healthSummary.degradedModeCount} providers in degraded mode`
        : 'No providers in degraded mode',
    });
    
    // Stale provider factor
    const staleProviderScore = degradedProviders.length > 0 ? 60 : 100;
    factors.push({
      factor: 'stale-providers',
      value: staleProviderScore,
      impact: degradedProviders.length > 0 ? 'high' : 'low',
      description: degradedProviders.length > 0
        ? `${degradedProviders.length} stale providers detected`
        : 'No stale providers',
    });
    
    const [claimCounts, platforms] = await Promise.all([
      ResumeEvidenceClaim.aggregate<{ total: number; verified: number }>([
        { $match: { userId: new Types.ObjectId(userId) } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            verified: { $sum: { $cond: [{ $eq: ['$verificationStatus', 'verified'] }, 1, 0] } },
          },
        },
      ]),
      ConnectedPlatform.find({ userId, platformName: { $in: benchmarkPlatforms }, isConnected: true })
        .select('platformName lastSyncedAt syncStatus')
        .lean(),
    ]);

    const { total: totalClaims, verified: verifiedClaims } = claimCounts[0] ?? { total: 0, verified: 0 };
    const evidenceCoverageScore = totalClaims > 0 ? Math.round(verifiedClaims / totalClaims * 100) : 20;
    factors.push({
      factor: 'evidence-coverage',
      value: evidenceCoverageScore,
      impact: evidenceCoverageScore < 30 ? 'high' : evidenceCoverageScore < 70 ? 'medium' : 'low',
      description: totalClaims > 0
        ? `${verifiedClaims} of ${totalClaims} resume evidence claims verified`
        : 'No resume evidence claims recorded',
    });

    const now = Date.now();
    const freshPlatforms = benchmarkPlatforms.filter(name => platforms.some(platform => {
      if (platform.platformName !== name || platform.syncStatus !== 'success' || !platform.lastSyncedAt) return false;
      const age = now - platform.lastSyncedAt.getTime();
      return age >= 0 && age <= benchmarkFreshnessMs;
    }));
    const benchmarkConfidenceScore = Math.round(freshPlatforms.length / benchmarkPlatforms.length * 100);
    factors.push({
      factor: 'benchmark-confidence',
      value: benchmarkConfidenceScore,
      impact: benchmarkConfidenceScore === 0 ? 'high' : benchmarkConfidenceScore < 70 ? 'medium' : 'low',
      description: freshPlatforms.length
        ? `Successful sync within 24 hours for ${freshPlatforms.join(' and ')} (${freshPlatforms.length} of ${benchmarkPlatforms.length} platforms)`
        : 'No successful GitHub or LeetCode sync within 24 hours',
    });

    return factors;
  }

  /**
   * Calculate provider health score
   */
  private calculateProviderHealthScore(healthSummary: any): number {
    const totalProviders = healthSummary.totalProviders || 0;
    if (totalProviders === 0) return 100;
    
    const healthyCount = healthSummary.healthyCount || 0;
    const degradedCount = healthSummary.degradedCount || 0;
    const downCount = healthSummary.downCount || 0;
    
    // Weight healthy providers positively, degraded/down negatively
    const score = ((healthyCount * 100) + (degradedCount * 50) + (downCount * 0)) / totalProviders;
    return Math.round(score);
  }

  /**
   * Calculate overall trust score
   */
  private calculateOverallTrustScore(factors: TrustFactor[]): number {
    if (factors.length === 0) return 100;
    
    // Weight critical factors more heavily
    const weightedSum = factors.reduce((sum, factor) => {
      const weight = factor.impact === 'high' ? 2 : factor.impact === 'medium' ? 1.5 : 1;
      return sum + factor.value * weight;
    }, 0);
    
    const totalWeight = factors.reduce((sum, factor) => {
      const weight = factor.impact === 'high' ? 2 : factor.impact === 'medium' ? 1.5 : 1;
      return sum + weight;
    }, 0);
    
    return Math.round(weightedSum / totalWeight);
  }

  /**
   * Adjust recommendations based on trust factors
   */
  private adjustRecommendations(
    recommendations: any[],
    trustFactors: TrustFactor[],
    overallTrustScore: number
  ): TrustAwareRecommendation[] {
    return recommendations.map(rec => {
      const originalConfidence = rec.confidence;
      const trustAdjustments: TrustAdjustment[] = [];
      
      // Adjust based on provider health
      const providerHealth = trustFactors.find(f => f.factor === 'provider-health');
      if (providerHealth && providerHealth.value < 80) {
        const adjustment = (100 - providerHealth.value) * 0.3;
        trustAdjustments.push({
          factor: 'provider-health',
          originalValue: originalConfidence,
          adjustedValue: originalConfidence - adjustment,
          reason: `Provider health reduced confidence by ${adjustment.toFixed(1)}%`,
        });
      }
      
      // Adjust based on degraded mode
      const degradedMode = trustFactors.find(f => f.factor === 'degraded-mode');
      if (degradedMode && degradedMode.value < 100) {
        const adjustment = (100 - degradedMode.value) * 0.2;
        trustAdjustments.push({
          factor: 'degraded-mode',
          originalValue: originalConfidence,
          adjustedValue: originalConfidence - adjustment,
          reason: `Degraded mode reduced confidence by ${adjustment.toFixed(1)}%`,
        });
      }
      
      // Adjust based on stale providers
      const staleProviders = trustFactors.find(f => f.factor === 'stale-providers');
      if (staleProviders && staleProviders.value < 100) {
        const adjustment = (100 - staleProviders.value) * 0.25;
        trustAdjustments.push({
          factor: 'stale-providers',
          originalValue: originalConfidence,
          adjustedValue: originalConfidence - adjustment,
          reason: `Stale providers reduced confidence by ${adjustment.toFixed(1)}%`,
        });
      }
      
      // Calculate adjusted confidence
      let adjustedConfidence = originalConfidence;
      trustAdjustments.forEach(adj => {
        adjustedConfidence = adj.adjustedValue;
      });
      
      const evidenceCoverage = trustFactors.find(f => f.factor === 'evidence-coverage');
      if (evidenceCoverage && evidenceCoverage.value < 70) {
        const evidenceAdjustedConfidence = Math.max(0, adjustedConfidence - (100 - evidenceCoverage.value) * 0.2);
        trustAdjustments.push({
          factor: evidenceCoverage.factor,
          originalValue: adjustedConfidence,
          adjustedValue: evidenceAdjustedConfidence,
          reason: `Limited verified evidence reduced confidence. ${evidenceCoverage.description}.`,
        });
        adjustedConfidence = evidenceAdjustedConfidence;
      }

      // Ensure confidence stays within bounds
      adjustedConfidence = Math.max(0, Math.min(100, adjustedConfidence));
      
      // Generate trust reasoning
      const trustReasoning = this.generateTrustReasoning(trustAdjustments, overallTrustScore);
      
      return {
        recommendationId: rec.recommendationId,
        title: rec.title,
        description: rec.description,
        originalConfidence,
        adjustedConfidence,
        trustAdjustments,
        isTrustReduced: adjustedConfidence < originalConfidence,
        trustReasoning,
        category: rec.type,
        priority: rec.priority,
        estimatedEffort: rec.estimatedEffort,
      };
    });
  }

  /**
   * Generate trust reasoning
   */
  private generateTrustReasoning(adjustments: TrustAdjustment[], overallTrustScore: number): string {
    if (adjustments.length === 0) {
      return 'No recommendation confidence adjustments were applied.';
    }
    
    const reasons = adjustments.map(adj => adj.reason);
    const baseReason = overallTrustScore < 70 
      ? `Overall trust score is ${overallTrustScore}%. `
      : '';
    
    return baseReason + reasons.join('. ');
  }

  /**
   * Generate warnings
   */
  private generateWarnings(trustFactors: TrustFactor[], degradedProviders: any[]): TrustWarning[] {
    const warnings: TrustWarning[] = [];
    
    // Check for critical provider health issues
    const providerHealth = trustFactors.find(f => f.factor === 'provider-health');
    if (providerHealth && providerHealth.value < 50) {
      warnings.push({
        severity: 'critical',
        message: 'Provider health is critically low',
        context: `Provider health score: ${providerHealth.value}%`,
        actionable: true,
      });
    }
    
    // Check for degraded mode
    const degradedMode = trustFactors.find(f => f.factor === 'degraded-mode');
    if (degradedMode && degradedMode.value < 100) {
      warnings.push({
        severity: 'warning',
        message: 'One or more providers are in degraded mode',
        context: degradedMode.description,
        actionable: true,
      });
    }
    
    // Check for stale providers
    const staleProvidersFactor = trustFactors.find(f => f.factor === 'stale-providers');
    if (staleProvidersFactor && staleProvidersFactor.value < 80) {
      warnings.push({
        severity: 'warning',
        message: 'Stale provider data detected',
        context: staleProvidersFactor.description,
        actionable: true,
      });
    }
    
    const evidenceCoverage = trustFactors.find(f => f.factor === 'evidence-coverage');
    if (evidenceCoverage && evidenceCoverage.value < 70) {
      warnings.push({
        severity: 'warning',
        message: 'Limited verified resume evidence',
        context: evidenceCoverage.description,
        actionable: true,
      });
    }

    const benchmarkConfidence = trustFactors.find(f => f.factor === 'benchmark-confidence');
    if (benchmarkConfidence && benchmarkConfidence.value < 70) {
      warnings.push({
        severity: 'warning',
        message: 'Benchmark data is incomplete or stale',
        context: benchmarkConfidence.description,
        actionable: true,
      });
    }

    // Add specific warnings for each degraded provider
    degradedProviders.forEach(provider => {
      warnings.push({
        severity: 'warning',
        message: `${provider.name} is in degraded mode`,
        context: provider.reason || 'Provider health check failed',
        actionable: false,
      });
    });
    
    return warnings;
  }

  /**
   * Get trust-aware next best action
   */
  async getTrustAwareNextBestAction(input: TrustAwareInput): Promise<TrustAwareRecommendation | null> {
    const guidance = await this.generateTrustAwareGuidance(input);
    
    if (guidance.recommendations.length === 0) {
      return null;
    }
    
    // Return the highest confidence recommendation
    const sorted = [...guidance.recommendations].sort((a, b) => b.adjustedConfidence - a.adjustedConfidence);
    return sorted[0];
  }

  /**
   * Check if guidance should be in degraded mode
   */
  shouldUseDegradedMode(userId: string): boolean {
    const healthSummary = ProviderHealthRegistry.getHealthSummary();
    return healthSummary.degradedModeCount > 0 || healthSummary.downCount > 0;
  }

  /**
   * Get provider-specific trust context
   */
  getProviderTrustContext(): {
    healthyProviders: string[];
    degradedProviders: string[];
    downProviders: string[];
    overallStatus: string;
  } {
    const healthSummary = ProviderHealthRegistry.getHealthSummary();
    const allProviders = ProviderHealthRegistry.getAllProviderHealth();
    
    const healthyProviders = allProviders.filter(p => p.status === 'healthy').map(p => p.providerName);
    const degradedProvidersList = allProviders.filter(p => p.status === 'degraded').map(p => p.providerName);
    const downProviders = allProviders.filter(p => p.status === 'down').map(p => p.providerName);
    
    let overallStatus = 'healthy';
    if (healthSummary.downCount > 0) overallStatus = 'critical';
    else if (healthSummary.degradedCount > 0) overallStatus = 'degraded';
    
    return {
      healthyProviders,
      degradedProviders: degradedProvidersList,
      downProviders,
      overallStatus,
    };
  }
}

export const TrustAwareGuidanceLayer = new TrustAwareGuidanceLayerClass();
