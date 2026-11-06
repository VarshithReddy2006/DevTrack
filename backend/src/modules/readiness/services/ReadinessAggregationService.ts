import { DsaIntelligenceEngine } from '../intelligence/DsaIntelligenceEngine.js';
import { SkillIntelligenceEngine } from '../intelligence/SkillIntelligenceEngine.js';
import { ProjectIntelligenceEngine } from '../intelligence/ProjectIntelligenceEngine.js';
import { SkillNodeVerificationEngine } from '../engine/SkillNodeVerificationEngine.js';
import { BenchmarkEngine } from '../benchmark/BenchmarkEngine.js';
import { TrustAwareReadinessScoringEngine } from '../scoring/TrustAwareReadinessScoringEngine.js';
import { ProviderHealthRegistry } from '../provider/ProviderHealthRegistry.js';
import { logger } from '../../../shared/logger.js';

export interface AggregationInput {
  userId: string;
  targetRole?: string;
  forceRefresh?: boolean;
}

export interface AggregationResult {
  success: boolean;
  userId: string;
  timestamp: Date;
  fragments: {
    dsa: boolean;
    skills: boolean;
    projects: boolean;
    roadmap: boolean;
    benchmarks: boolean;
    scoring: boolean;
  };
  overallScore?: number;
  readinessTier?: string;
  isDegraded: boolean;
  staleProviders: string[];
  errors: string[];
}

class ReadinessAggregationServiceClass {
  /**
   * Aggregate all intelligence fragments for a user
   */
  async aggregateReadiness(input: AggregationInput): Promise<AggregationResult> {
    const { userId, targetRole, forceRefresh = false } = input;
    const errors: string[] = [];
    const fragments = {
      dsa: false,
      skills: false,
      projects: false,
      roadmap: false,
      benchmarks: false,
      scoring: false,
    };

    try {
      logger.info('[ReadinessAggregationService] Starting aggregation', { userId, targetRole });

      // Check provider health before aggregation
      const isDegraded = ProviderHealthRegistry.isAnyProviderDegraded();
      const degradedProviders = ProviderHealthRegistry.getDegradedProviders();
      const staleProviders = degradedProviders.map(p => p.providerId);

      // Run DSA Intelligence Engine
      try {
        await DsaIntelligenceEngine.generateIntelligence({ userId });
        fragments.dsa = true;
        logger.info('[ReadinessAggregationService] DSA intelligence extracted');
      } catch (error) {
        const errorMsg = `DSA intelligence failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        logger.error('[ReadinessAggregationService] DSA intelligence failed', { userId, error });
      }

      // Run Skills Intelligence Engine
      try {
        await SkillIntelligenceEngine.generateIntelligence({ userId });
        fragments.skills = true;
        logger.info('[ReadinessAggregationService] Skills intelligence extracted');
      } catch (error) {
        const errorMsg = `Skills intelligence failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        logger.error('[ReadinessAggregationService] Skills intelligence failed', { userId, error });
      }

      // Run Projects Intelligence Engine
      try {
        await ProjectIntelligenceEngine.generateIntelligence({ userId });
        fragments.projects = true;
        logger.info('[ReadinessAggregationService] Projects intelligence extracted');
      } catch (error) {
        const errorMsg = `Projects intelligence failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        logger.error('[ReadinessAggregationService] Projects intelligence failed', { userId, error });
      }

      // Run Skill Node Verification Engine
      try {
        await SkillNodeVerificationEngine.verifyNodes({ userId, targetRole });
        fragments.roadmap = true;
        logger.info('[ReadinessAggregationService] Skill node verification completed');
      } catch (error) {
        const errorMsg = `Skill node verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        logger.error('[ReadinessAggregationService] Skill node verification failed', { userId, error });
      }

      // Run Benchmark Engine
      try {
        await BenchmarkEngine.generateBenchmarks({ userId });
        fragments.benchmarks = true;
        logger.info('[ReadinessAggregationService] Benchmarks generated');
      } catch (error) {
        const errorMsg = `Benchmark generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        logger.error('[ReadinessAggregationService] Benchmark generation failed', { userId, error });
      }

      // Run Trust-Aware Readiness Scoring Engine
      try {
        const scoringResult = await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId });
        fragments.scoring = true;
        logger.info('[ReadinessAggregationService] Readiness score calculated', { 
          overallScore: scoringResult.overallScore,
          readinessTier: scoringResult.readinessTier 
        });
      } catch (error) {
        const errorMsg = `Readiness scoring failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(errorMsg);
        logger.error('[ReadinessAggregationService] Readiness scoring failed', { userId, error });
      }

      // Determine success based on critical fragments
      const criticalFragments = ['dsa', 'skills', 'projects', 'scoring'];
      const success = criticalFragments.every(f => fragments[f as keyof typeof fragments]);

      const result: AggregationResult = {
        success,
        userId,
        timestamp: new Date(),
        fragments,
        isDegraded,
        staleProviders,
        errors,
      };

      logger.info('[ReadinessAggregationService] Aggregation completed', { 
        userId, 
        success, 
        fragmentCount: Object.values(fragments).filter(Boolean).length,
        errorCount: errors.length 
      });

      return result;
    } catch (error) {
      logger.error('[ReadinessAggregationService] Aggregation failed', { userId, error });
      
      return {
        success: false,
        userId,
        timestamp: new Date(),
        fragments,
        isDegraded: ProviderHealthRegistry.isAnyProviderDegraded(),
        staleProviders: ProviderHealthRegistry.getDegradedProviders().map(p => p.providerId),
        errors: [`Aggregation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
      };
    }
  }

  /**
   * Get aggregation status for a user
   */
  getAggregationStatus(userId: string): {
    lastAggregated: Date | null;
    fragmentStatus: {
      dsa: boolean;
      skills: boolean;
      projects: boolean;
      roadmap: boolean;
      benchmarks: boolean;
      scoring: boolean;
    };
    isComplete: boolean;
  } {
    // In production, this would query the database for last aggregation status
    // For now, return a mock status
    return {
      lastAggregated: null,
      fragmentStatus: {
        dsa: false,
        skills: false,
        projects: false,
        roadmap: false,
        benchmarks: false,
        scoring: false,
      },
      isComplete: false,
    };
  }

  /**
   * Trigger partial refresh of specific fragments
   */
  async refreshFragments(userId: string, fragmentTypes: string[]): Promise<AggregationResult> {
    const errors: string[] = [];
    const fragments = {
      dsa: false,
      skills: false,
      projects: false,
      roadmap: false,
      benchmarks: false,
      scoring: false,
    };

    logger.info('[ReadinessAggregationService] Refreshing fragments', { userId, fragmentTypes });

    for (const fragmentType of fragmentTypes) {
      switch (fragmentType) {
        case 'dsa':
          try {
            await DsaIntelligenceEngine.generateIntelligence({ userId });
            fragments.dsa = true;
          } catch (error) {
            errors.push(`DSA refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
          break;
        case 'skills':
          try {
            await SkillIntelligenceEngine.generateIntelligence({ userId });
            fragments.skills = true;
          } catch (error) {
            errors.push(`Skills refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
          break;
        case 'projects':
          try {
            await ProjectIntelligenceEngine.generateIntelligence({ userId });
            fragments.projects = true;
          } catch (error) {
            errors.push(`Projects refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
          break;
        case 'roadmap':
          try {
            await SkillNodeVerificationEngine.verifyNodes({ userId });
            fragments.roadmap = true;
          } catch (error) {
            errors.push(`Roadmap refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
          break;
        case 'benchmarks':
          try {
            await BenchmarkEngine.generateBenchmarks({ userId });
            fragments.benchmarks = true;
          } catch (error) {
            errors.push(`Benchmarks refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
          break;
        case 'scoring':
          try {
            await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId });
            fragments.scoring = true;
          } catch (error) {
            errors.push(`Scoring refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
          break;
        default:
          errors.push(`Unknown fragment type: ${fragmentType}`);
      }
    }

    // Re-run scoring if any fragment was refreshed
    if (Object.values(fragments).some(Boolean)) {
      try {
        await TrustAwareReadinessScoringEngine.calculateReadinessScore({ userId });
        fragments.scoring = true;
      } catch (error) {
        errors.push(`Scoring re-calculation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const isDegraded = ProviderHealthRegistry.isAnyProviderDegraded();
    const staleProviders = ProviderHealthRegistry.getDegradedProviders().map(p => p.providerId);

    return {
      success: errors.length === 0,
      userId,
      timestamp: new Date(),
      fragments,
      isDegraded,
      staleProviders,
      errors,
    };
  }
}

export const ReadinessAggregationService = new ReadinessAggregationServiceClass();
