import { ReadinessCore } from '../../../db/models/readinessCore.model.js';
import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { ReadinessRoadmap } from '../../../db/models/readinessRoadmap.model.js';
import { ReadinessBenchmarks, type IReadinessBenchmarks } from '../../../db/models/readinessBenchmarks.model.js';
import { CareerIntent } from '../../../db/models/careerIntent.model.js';
import { logger } from '../../../shared/logger.js';
import { ReadinessSnapshotService } from '../snapshot/ReadinessSnapshotService.js';

export const READINESS_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScoringInput {
  userId: string;
  unavailablePillars?: string[];
  persist?: boolean;
}

export interface ReadinessScore {
  overallScore: number; // 0-100
  dsaScore: number;
  skillsScore: number;
  projectsScore: number;
  roadmapScore: number;
  benchmarkPercentile: number;
  confidenceLevel: number; // 0-100
  isDegraded: boolean;
  staleProviders: string[];
  missingPillars: string[];
  completeness: number;
  scoringExplanation: string[];
  evidenceChain: string[];
  roleAlignmentScore: number;
  readinessTier: 'not_ready' | 'early' | 'developing' | 'ready' | 'strong';
}

export const TrustAwareReadinessScoringEngine = {
  /**
   * Calculate trust-aware, deterministic readiness score.
   * Aggregates all intelligence fragments with confidence-weighted scoring.
   * NO AI predictions - only objective, evidence-based metrics.
   */
  async calculateReadinessScore(input: ScoringInput): Promise<ReadinessScore> {
    try {
      const { userId } = input;
      
      const readInput = async <T>(query: PromiseLike<T>): Promise<T | null> => {
        try {
          return await query;
        } catch (error) {
          logger.warn('[TrustAwareReadinessScoringEngine] Readiness input unavailable', { userId, error });
          return null;
        }
      };
      const [dsa, skills, projects, roadmap, benchmarks, careerIntent] = await Promise.all([
        readInput(ReadinessDsa.findOne({ userId })),
        readInput(ReadinessSkills.findOne({ userId })),
        readInput(ReadinessProjects.findOne({ userId })),
        readInput(ReadinessRoadmap.findOne({ userId })),
        readInput(ReadinessBenchmarks.findOne({ userId })),
        readInput(CareerIntent.findOne({ userId })),
      ]);

      const missingPillars: string[] = [];
      const staleProviders: string[] = [];
      const freshnessThreshold = Date.now() - READINESS_FRESHNESS_MS;
      const available = (name: string, model: { computedAt?: Date } | null) => {
        if (!model || input.unavailablePillars?.includes(name)) {
          missingPillars.push(name);
          return false;
        }
        if (!model.computedAt || model.computedAt.getTime() < freshnessThreshold) {
          staleProviders.push(name);
          return false;
        }
        return true;
      };

      const hasDsa = available('DSA', dsa);
      const hasSkills = available('Skills', skills);
      const hasProjects = available('Projects', projects?.evidenceCoverage ? projects : null);
      const hasRoadmap = available('Roadmap', roadmap);
      const hasBenchmarks = available('Benchmarks', benchmarks);
      const hasRoleAlignment = Boolean(careerIntent && (hasSkills || hasProjects));
      const isDegraded = missingPillars.length > 0 || staleProviders.length > 0;

      const dsaScore = this.calculateDSAScore(dsa, !hasDsa);
      const skillsScore = this.calculateSkillsScore(skills, !hasSkills);
      const projectsScore = this.calculateProjectsScore(projects, !hasProjects);
      const roadmapScore = this.calculateRoadmapScore(roadmap, !hasRoadmap);
      const benchmarkPercentile = hasBenchmarks ? this.calculateBenchmarkPercentile(benchmarks) : 0;
      const roleAlignmentScore = hasRoleAlignment
        ? this.calculateRoleAlignment(careerIntent, hasSkills ? skills : null, hasProjects ? projects : null)
        : 0;

      const pillars = [
        { available: hasDsa, score: dsaScore, weight: 20, confidence: dsa?.confidenceScore },
        { available: hasSkills, score: skillsScore, weight: 30, confidence: skills?.confidenceScore },
        { available: hasProjects, score: projectsScore, weight: 25, confidence: projects?.confidenceScore },
        { available: hasRoadmap, score: roadmapScore, weight: 15, confidence: roadmap?.confidenceScore },
      ].filter(pillar => pillar.available);
      const evidenceWeight = pillars.reduce((sum, pillar) => sum + pillar.weight, 0);
      const completeness = Math.round(evidenceWeight / 90 * 100);
      const confidenceLevel = Math.round(
        pillars.reduce((sum, pillar) => sum + (pillar.confidence ?? 0) * pillar.weight, 0) / 90
      );
      const weight = evidenceWeight + (hasRoleAlignment ? 10 : 0);
      const weightedScore = pillars.reduce((sum, pillar) => sum + pillar.score * pillar.weight, 0)
        + roleAlignmentScore * 10;
      const benchmarkAdjustment = hasBenchmarks && benchmarks?.cohortSegments?.length
        ? this.benchmarkAdjustment(benchmarkPercentile)
        : 0;
      const overallScore = weight
        ? Math.min(100, Math.max(0, Math.round(weightedScore / weight + benchmarkAdjustment)))
        : 0;

      // Generate scoring explanation
      const scoringExplanation = this.generateScoringExplanation(
        overallScore,
        dsaScore,
        skillsScore,
        projectsScore,
        roadmapScore,
        benchmarkPercentile,
        roleAlignmentScore,
        isDegraded
      );
      
      // Generate evidence chain
      const evidenceChain = this.generateEvidenceChain(
        hasDsa ? dsa : null,
        hasSkills ? skills : null,
        hasProjects ? projects : null,
        hasRoadmap ? roadmap : null
      );
      
      // Determine readiness tier
      const readinessTier = this.determineReadinessTier(overallScore, confidenceLevel);
      
      if (input.persist !== false) {
        const core = await ReadinessCore.findOneAndUpdate(
          { userId },
          {
            overallScore,
            dsaScore,
            skillsScore,
            projectsScore,
            roadmapScore,
            benchmarkPercentile,
            targetRoleAlignment: roleAlignmentScore,
            confidence: confidenceLevel,
            confidenceScore: confidenceLevel,
            isDegraded,
            staleProviders,
            missingPillars,
            completeness,
            scoringExplanation,
            evidenceChain,
            readinessTier,
            snapshotVersion: '1.0.0',
            analyticsVersion: '1.0.0',
            scoringVersion: '1.1.0',
            computedAt: new Date(),
          },
          { upsert: true, new: true }
        ).lean();
        await ReadinessSnapshotService.saveReadinessSnapshot(userId, {
          core,
          dsa: hasDsa ? dsa?.toObject() : null,
          skills: hasSkills ? skills?.toObject() : null,
          projects: hasProjects ? projects?.toObject() : null,
          roadmap: hasRoadmap ? roadmap?.toObject() : null,
          benchmarks: hasBenchmarks ? benchmarks?.toObject() : null,
        }, 'Readiness score updated', 'system', { dsaScore, skillsScore, projectsScore });
      }

      logger.info('[TrustAwareReadinessScoringEngine] Successfully calculated readiness score', { 
        userId, 
        overallScore,
        readinessTier 
      });
      
      return {
        overallScore,
        dsaScore,
        skillsScore,
        projectsScore,
        roadmapScore,
        benchmarkPercentile,
        confidenceLevel,
        isDegraded,
        staleProviders,
        missingPillars,
        completeness,
        scoringExplanation,
        evidenceChain,
        roleAlignmentScore,
        readinessTier,
      };
    } catch (error) {
      logger.error('[TrustAwareReadinessScoringEngine] Failed to calculate score', { input, error });
      throw error;
    }
  },

  /**
   * Calculate DSA score with confidence weighting
   */
  calculateDSAScore(dsa: any, unavailable: boolean): number {
    if (!dsa || unavailable) return 0;
    
    let score = 0;
    
    // Total solves contributes (max 30 points)
    score += Math.min(30, (dsa.totalSolves || 0) * 0.3);
    
    // Hard problem progression contributes (max 25 points)
    score += Math.min(25, (dsa.hardProblemProgression || 0) * 0.25);
    
    // Solve consistency contributes (max 20 points)
    score += Math.min(20, (dsa.solveConsistency || 0) * 0.2);
    
    // Confidence score contributes (max 15 points)
    score += Math.min(15, (dsa.confidenceScore || 0) * 0.15);
    
    // Evidence coverage contributes (max 10 points)
    score += Math.min(10, (dsa.evidenceCoverage || 0) * 0.1);
    
    return Math.min(100, Math.round(score));
  },

  /**
   * Calculate Skills score with confidence weighting
   */
  calculateSkillsScore(skills: any, unavailable: boolean): number {
    if (!skills || unavailable) return 0;
    
    let score = 0;
    
    // Overall engineering depth contributes (max 40 points)
    score += Math.min(40, (skills.overallEngineeringDepth || 0) * 0.4);
    
    // Confidence score contributes (max 30 points)
    score += Math.min(30, (skills.confidenceScore || 0) * 0.3);
    
    // Evidence coverage contributes (max 20 points)
    score += Math.min(20, (skills.evidenceCoverage || 0) * 0.2);
    
    // Domain diversity contributes (max 10 points)
    const domainCount = skills.domains?.length || 0;
    score += Math.min(10, domainCount * 2);
    
    return Math.min(100, Math.round(score));
  },

  /**
   * Calculate Projects score with confidence weighting
   */
  calculateProjectsScore(projects: any, unavailable: boolean): number {
    if (!projects || unavailable) return 0;
    
    let score = 0;
    
    // Project credibility score contributes (max 35 points)
    score += Math.min(35, (projects.projectCredibilityScore || 0) * 0.35);
    
    // Engineering maturity contributes (max 25 points)
    score += Math.min(25, (projects.engineeringMaturity || 0) * 0.25);
    
    // Infrastructure sophistication contributes (max 20 points)
    score += Math.min(20, (projects.infrastructureSophistication || 0) * 0.2);
    
    // Confidence score contributes (max 10 points)
    score += Math.min(10, (projects.confidenceScore || 0) * 0.1);
    
    // Deployment evidence contributes (max 10 points)
    score += Math.min(10, (projects.deploymentEvidence || 0) * 0.1);
    
    return Math.min(100, Math.round(score));
  },

  /**
   * Calculate Roadmap score with confidence weighting
   */
  calculateRoadmapScore(roadmap: any, unavailable: boolean): number {
    if (!roadmap || unavailable) return 0;
    
    let score = 0;
    
    // Verified nodes count contributes (max 40 points)
    const verifiedCount = roadmap.verifiedNodes?.length || 0;
    score += Math.min(40, verifiedCount * 5);
    
    // Confidence score contributes (max 30 points)
    score += Math.min(30, (roadmap.confidenceScore || 0) * 0.3);
    
    // Evidence coverage contributes (max 20 points)
    score += Math.min(20, (roadmap.evidenceCoverage || 0) * 0.2);
    
    // Next best actions completeness (max 10 points)
    const actionCount = roadmap.nextBestActions?.length || 0;
    score += Math.min(10, actionCount * 2);
    
    return Math.min(100, Math.round(score));
  },

  /**
   * Calculate benchmark percentile
   */
  calculateBenchmarkPercentile(benchmarks: IReadinessBenchmarks | null): number {
    if (!benchmarks) return 0;
    
    // Use the average percentile across all metrics
    const rankings = benchmarks.cohortSegments || [];
    if (rankings.length === 0) return 0;
    
    const totalPercentile = rankings.reduce((sum, cohort) => sum + cohort.percentileRanking, 0);
    return Math.round(totalPercentile / rankings.length);
  },

  /**
   * Calculate role alignment score
   */
  calculateRoleAlignment(careerIntent: any, skills: any, projects: any): number {
    if (!careerIntent) return 0;
    
    let score = 0;
    
    // Check if skills match target role
    const targetRole = careerIntent.dreamRole?.toLowerCase() || '';
    const domains = skills?.domains || [];
    
    // Role-specific skill matching
    const roleSkillMap: Record<string, string[]> = {
      'backend': ['backend', 'database', 'system-design'],
      'frontend': ['frontend'],
      'full stack': ['frontend', 'backend', 'database'],
      'devops': ['devops', 'cloud', 'infrastructure'],
    };
    
    const relevantCategories = roleSkillMap[targetRole] || [];
    const matchingDomains = domains.filter((d: any) => 
      relevantCategories.some(cat => d.name.toLowerCase().includes(cat))
    );
    
    score += Math.min(50, matchingDomains.length * 15);
    
    // Check project alignment with target role
    const engineeringMaturity = projects?.engineeringMaturity || 0;
    score += Math.min(30, engineeringMaturity * 0.3);
    
    // Check confidence state
    const confidenceState = careerIntent.confidenceState || 'exploring';
    if (confidenceState === 'committed') score += 20;
    else if (confidenceState === 'exploring') score += 10;
    
    return Math.min(100, Math.round(score));
  },

  benchmarkAdjustment(percentile: number): number {
    if (percentile >= 80) return 5;
    if (percentile >= 60) return 2;
    if (percentile < 20) return -5;
    return 0;
  },

  /**
   * Generate scoring explanation
   */
  generateScoringExplanation(
    overallScore: number,
    dsaScore: number,
    skillsScore: number,
    projectsScore: number,
    roadmapScore: number,
    benchmarkPercentile: number,
    roleAlignmentScore: number,
    isDegraded: boolean
  ): string[] {
    const explanation: string[] = [];
    
    if (isDegraded) {
      explanation.push('Score calculated in degraded mode with missing or stale inputs');
    }
    
    explanation.push(`Overall readiness score: ${overallScore}/100`);
    explanation.push(`DSA performance: ${dsaScore}/100`);
    explanation.push(`Skills depth: ${skillsScore}/100`);
    explanation.push(`Projects credibility: ${projectsScore}/100`);
    explanation.push(`Roadmap progress: ${roadmapScore}/100`);
    explanation.push(`Role alignment: ${roleAlignmentScore}/100`);
    
    if (benchmarkPercentile > 0) {
      explanation.push(`Cohort percentile: ${benchmarkPercentile}%`);
    }
    
    return explanation;
  },

  /**
   * Generate evidence chain
   */
  generateEvidenceChain(
    dsa: any,
    skills: any,
    projects: any,
    roadmap: any
  ): string[] {
    const chain: string[] = [];
    
    if (dsa?.totalSolves > 0) {
      chain.push(`DSA: ${dsa.totalSolves} problems solved with ${dsa.confidenceScore}% confidence`);
    }
    
    if (skills?.overallEngineeringDepth > 0) {
      chain.push(`Skills: ${skills.overallEngineeringDepth}% engineering depth across ${skills.domains?.length || 0} domains`);
    }
    
    if (projects?.projectCredibilityScore > 0) {
      chain.push(`Projects: ${projects.projectCredibilityScore}% credibility with ${projects.engineeringMaturity}% engineering maturity`);
    }
    
    if (roadmap?.verifiedNodes?.length > 0) {
      chain.push(`Roadmap: ${roadmap.verifiedNodes.length} skill nodes verified`);
    }
    
    if (chain.length === 0) {
      chain.push('No evidence available - complete onboarding to generate readiness score');
    }
    
    return chain;
  },

  /**
   * Determine readiness tier
   */
  determineReadinessTier(overallScore: number, confidenceLevel: number): 'not_ready' | 'early' | 'developing' | 'ready' | 'strong' {
    // Require minimum confidence for higher tiers
    if (confidenceLevel < 50) {
      if (overallScore >= 40) return 'developing';
      return 'not_ready';
    }
    
    if (overallScore >= 80) return 'strong';
    if (overallScore >= 60) return 'ready';
    if (overallScore >= 40) return 'developing';
    if (overallScore >= 20) return 'early';
    return 'not_ready';
  },
};
