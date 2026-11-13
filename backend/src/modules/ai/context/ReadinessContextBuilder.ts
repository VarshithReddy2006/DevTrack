import { ReadinessDsa } from '../../../db/models/readinessDsa.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { ReadinessRoadmap } from '../../../db/models/readinessRoadmap.model.js';
import { ReadinessBenchmarks } from '../../../db/models/readinessBenchmarks.model.js';
import { IntelligentRecommendationEngine } from '../../readiness/recommendation/IntelligentRecommendationEngine.js';
import { ReadinessMomentumEngine } from '../../readiness/momentum/ReadinessMomentumEngine.js';
import { ProgressionStateEngine } from '../../readiness/progression/ProgressionStateEngine.js';
import { DynamicRoadmapExperience } from '../../readiness/roadmap/DynamicRoadmapExperience.js';
import { ProviderHealthRegistry } from '../../readiness/provider/ProviderHealthRegistry.js';
import { logger } from '../../../shared/logger.js';

export interface ContextInput {
  userId: string;
  targetRole?: string;
  contextType: 'general' | 'recommendation' | 'roadmap' | 'readiness' | 'progression';
  specificId?: string;
}

export interface ReadinessContext {
  userId: string;
  contextType: string;
  timestamp: Date;
  readinessSummary: ReadinessSummary;
  evidenceChains: EvidenceChain[];
  roadmapGaps: RoadmapGap[];
  progressionState: ProgressionState;
  recommendations: RecommendationSummary[];
  benchmarkInsights: BenchmarkInsight;
  momentumSignals: MomentumSignal;
  trustConfidence: TrustConfidence;
  providerFreshness: ProviderFreshness;
  verifiedSkillData: VerifiedSkillData;
  contextVersion: string;
}

export interface ReadinessSummary {
  overallScore: number;
  dsaScore: number;
  skillsScore: number;
  projectsScore: number;
  infrastructureScore: number;
  roadmapProgress: number;
  confidenceScore: number;
  evidenceCoverage: number;
}

export interface EvidenceChain {
  component: string;
  evidence: string[];
  confidence: number;
}

export interface RoadmapGap {
  nodeId: string;
  nodeName: string;
  type: string;
  severity: string;
  description: string;
}

export interface ProgressionState {
  currentState: string;
  readinessForNextState: number;
  requirements: string[];
}

export interface RecommendationSummary {
  title: string;
  type: string;
  priority: string;
  confidence: number;
  reasoning: string;
  expectedImpact: string;
}

export interface BenchmarkInsight {
  percentileRanking: number;
  relativeComparisons: string[];
  confidenceLevel: number;
}

export interface MomentumSignal {
  overallMomentum: number;
  momentumState: string;
  insights: string[];
}

export interface TrustConfidence {
  overallConfidence: number;
  confidenceReasoning: string;
  evidenceCoverage: number;
}

export interface ProviderFreshness {
  githubFreshness: number;
  leetcodeFreshness: number;
  codeforcesFreshness: number;
  staleProviders: string[];
}

export interface VerifiedSkillData {
  verifiedSkills: string[];
  verifiedNodes: string[];
  missingDependencies: string[];
}

class ReadinessContextBuilderClass {
  private contextVersion: string = '1.0.0';

  /**
   * Build deterministic readiness context for AI interpretation
   */
  async buildContext(input: ContextInput): Promise<ReadinessContext> {
    const { userId, targetRole, contextType, specificId } = input;
    
    try {
      logger.info('[ReadinessContextBuilder] Building context', { userId, contextType });
      
      // Fetch readiness data
      const [dsaData, skillsData, projectsData, roadmapData, benchmarksData] = await Promise.all([
        ReadinessDsa.findOne({ userId }),
        ReadinessSkills.findOne({ userId }),
        ReadinessProjects.findOne({ userId }),
        ReadinessRoadmap.findOne({ userId }),
        ReadinessBenchmarks.findOne({ userId }),
      ]);
      
      // Build readiness summary
      const readinessSummary = this.buildReadinessSummary(dsaData, skillsData, projectsData, roadmapData);
      
      // Build evidence chains
      const evidenceChains = this.buildEvidenceChains(dsaData, skillsData, projectsData, roadmapData);
      
      // Build roadmap gaps
      const roadmapGaps = this.buildRoadmapGaps(roadmapData);
      
      // Build progression state
      const progressionState = await this.buildProgressionState(userId, targetRole);
      
      // Build recommendations summary
      const recommendations = await this.buildRecommendationsSummary(userId, targetRole);
      
      // Build benchmark insights
      const benchmarkInsights = this.buildBenchmarkInsights(benchmarksData);
      
      // Build momentum signals
      const momentumSignals = await this.buildMomentumSignals(userId);
      
      // Build trust confidence
      const trustConfidence = this.buildTrustConfidence(dsaData, skillsData, projectsData, roadmapData);
      
      // Build provider freshness
      const providerFreshness = this.buildProviderFreshness();
      
      // Build verified skill data
      const verifiedSkillData = this.buildVerifiedSkillData(roadmapData);
      
      const context: ReadinessContext = {
        userId,
        contextType,
        timestamp: new Date(),
        readinessSummary,
        evidenceChains,
        roadmapGaps,
        progressionState,
        recommendations,
        benchmarkInsights,
        momentumSignals,
        trustConfidence,
        providerFreshness,
        verifiedSkillData,
        contextVersion: this.contextVersion,
      };
      
      logger.info('[ReadinessContextBuilder] Context built', { userId, contextType });
      
      return context;
    } catch (error) {
      logger.error('[ReadinessContextBuilder] Failed to build context', { userId, error });
      throw error;
    }
  }

  /**
   * Build readiness summary
   */
  private buildReadinessSummary(
    dsaData: any,
    skillsData: any,
    projectsData: any,
    roadmapData: any
  ): ReadinessSummary {
    const dsaScore = dsaData?.overallEngineeringDepth || 0;
    const skillsScore = skillsData?.overallEngineeringDepth || 0;
    const projectsScore = projectsData?.engineeringMaturity || 0;
    const infrastructureScore = projectsData?.infrastructureSophistication || 0;
    const roadmapProgress = roadmapData 
      ? (roadmapData.verifiedNodes.length / (roadmapData.verifiedNodes.length + roadmapData.missingDependencies.length)) * 100 
      : 0;
    
    const overallScore = (dsaScore + skillsScore + projectsScore + infrastructureScore) / 4;
    const confidenceScore = Math.min(
      dsaData?.confidenceScore || 50,
      skillsData?.confidenceScore || 50,
      projectsData?.confidenceScore || 50
    );
    const evidenceCoverage = Math.min(
      dsaData?.evidenceCoverage || 50,
      skillsData?.evidenceCoverage || 50,
      projectsData?.evidenceCoverage || 50
    );
    
    return {
      overallScore: Math.round(overallScore),
      dsaScore: Math.round(dsaScore),
      skillsScore: Math.round(skillsScore),
      projectsScore: Math.round(projectsScore),
      infrastructureScore: Math.round(infrastructureScore),
      roadmapProgress: Math.round(roadmapProgress),
      confidenceScore: Math.round(confidenceScore),
      evidenceCoverage: Math.round(evidenceCoverage),
    };
  }

  /**
   * Build evidence chains
   */
  private buildEvidenceChains(
    dsaData: any,
    skillsData: any,
    projectsData: any,
    roadmapData: any
  ): EvidenceChain[] {
    const chains: EvidenceChain[] = [];
    
    if (dsaData?.confidenceScore) {
      chains.push({
        component: 'DSA',
        evidence: [`Total solves: ${dsaData.totalSolves}`, `Hard progression: ${dsaData.hardProblemProgression}%`],
        confidence: dsaData.confidenceScore,
      });
    }
    
    if (skillsData?.confidenceScore) {
      chains.push({
        component: 'Skills',
        evidence: [`Engineering depth: ${skillsData.overallEngineeringDepth}%`, `Verified skills: ${skillsData.verifiedSkills?.length || 0}`],
        confidence: skillsData.confidenceScore,
      });
    }
    
    if (projectsData?.confidenceScore) {
      chains.push({
        component: 'Projects',
        evidence: [`Engineering maturity: ${projectsData.engineeringMaturity}%`, `Infrastructure sophistication: ${projectsData.infrastructureSophistication}%`],
        confidence: projectsData.confidenceScore,
      });
    }
    
    if (roadmapData?.confidenceScore) {
      chains.push({
        component: 'Roadmap',
        evidence: [`Verified nodes: ${roadmapData.verifiedNodes.length}`, `Missing dependencies: ${roadmapData.missingDependencies.length}`],
        confidence: roadmapData.confidenceScore,
      });
    }
    
    return chains;
  }

  /**
   * Build roadmap gaps
   */
  private buildRoadmapGaps(roadmapData: any): RoadmapGap[] {
    const gaps: RoadmapGap[] = [];
    
    if (roadmapData?.missingDependencies) {
      roadmapData.missingDependencies.forEach((dep: any) => {
        gaps.push({
          nodeId: dep.nodeId,
          nodeName: dep.nodeId,
          type: 'missing-dependency',
          severity: dep.importance,
          description: dep.reasoning,
        });
      });
    }
    
    return gaps;
  }

  /**
   * Build progression state
   */
  private async buildProgressionState(userId: string, targetRole?: string): Promise<ProgressionState> {
    try {
      const progression = await ProgressionStateEngine.analyzeProgressionState({ userId, targetRole });
      
      return {
        currentState: progression.currentState,
        readinessForNextState: progression.readinessForNextState,
        requirements: progression.requirementsForNextState.map((r: any) => r.requirement),
      };
    } catch (error) {
      logger.error('[ReadinessContextBuilder] Failed to build progression state', { userId, error });
      return {
        currentState: 'unknown',
        readinessForNextState: 0,
        requirements: [],
      };
    }
  }

  /**
   * Build recommendations summary
   */
  private async buildRecommendationsSummary(userId: string, targetRole?: string): Promise<RecommendationSummary[]> {
    try {
      const recommendations = await IntelligentRecommendationEngine.generateRecommendations({
        userId,
        targetRole,
        maxRecommendations: 5,
      });
      
      return recommendations.map((rec: any) => ({
        title: rec.title,
        type: rec.type,
        priority: rec.priority,
        confidence: rec.confidence,
        reasoning: rec.reasoning,
        expectedImpact: rec.expectedImpact,
      }));
    } catch (error) {
      logger.error('[ReadinessContextBuilder] Failed to build recommendations', { userId, error });
      return [];
    }
  }

  /**
   * Build benchmark insights
   */
  private buildBenchmarkInsights(benchmarksData: any): BenchmarkInsight {
    if (!benchmarksData) {
      return {
        percentileRanking: 0,
        relativeComparisons: [],
        confidenceLevel: 0,
      };
    }
    
    const relativeComparisons = benchmarksData.relativeComparisons?.map((r: any) => 
      `${r.metric}: ${r.interpretation} (${r.cohortPercentile}%)`
    ) || [];
    
    return {
      percentileRanking: benchmarksData.cohortSegments?.[0]?.percentileRanking ?? 0,
      relativeComparisons,
      confidenceLevel: benchmarksData.cohortSegments?.[0]?.confidenceLevel || 0,
    };
  }

  /**
   * Build momentum signals
   */
  private async buildMomentumSignals(userId: string): Promise<MomentumSignal> {
    try {
      const momentum = await ReadinessMomentumEngine.analyzeMomentum({ userId, timeframe: 'month' });
      
      return {
        overallMomentum: momentum.overallMomentum,
        momentumState: momentum.momentumState,
        insights: momentum.insights.map((i: any) => i.description),
      };
    } catch (error) {
      logger.error('[ReadinessContextBuilder] Failed to build momentum signals', { userId, error });
      return {
        overallMomentum: 0,
        momentumState: 'stable',
        insights: [],
      };
    }
  }

  /**
   * Build trust confidence
   */
  private buildTrustConfidence(
    dsaData: any,
    skillsData: any,
    projectsData: any,
    roadmapData: any
  ): TrustConfidence {
    const confidenceScores = [
      dsaData?.confidenceScore || 50,
      skillsData?.confidenceScore || 50,
      projectsData?.confidenceScore || 50,
      roadmapData?.confidenceScore || 50,
    ];
    
    const overallConfidence = confidenceScores.reduce((sum, score) => sum + score, 0) / confidenceScores.length;
    
    const evidenceCoverages = [
      dsaData?.evidenceCoverage || 50,
      skillsData?.evidenceCoverage || 50,
      projectsData?.evidenceCoverage || 50,
      roadmapData?.evidenceCoverage || 50,
    ];
    
    const evidenceCoverage = evidenceCoverages.reduce((sum, coverage) => sum + coverage, 0) / evidenceCoverages.length;
    
    let confidenceReasoning = `Overall confidence is ${Math.round(overallConfidence)}%. `;
    if (overallConfidence < 70) {
      confidenceReasoning += 'Some readiness components have limited evidence coverage.';
    } else {
      confidenceReasoning += 'Readiness components have good evidence coverage.';
    }
    
    return {
      overallConfidence: Math.round(overallConfidence),
      confidenceReasoning,
      evidenceCoverage: Math.round(evidenceCoverage),
    };
  }

  /**
   * Build provider freshness
   */
  private buildProviderFreshness(): ProviderFreshness {
    const healthSummary = ProviderHealthRegistry.getHealthSummary();
    const allProviders = ProviderHealthRegistry.getAllProviderHealth();
    
    const githubProvider = allProviders.find(p => p.providerId === 'github');
    const leetcodeProvider = allProviders.find(p => p.providerId === 'leetcode');
    const codeforcesProvider = allProviders.find(p => p.providerId === 'codeforces');
    
    const githubFreshness = githubProvider?.status === 'healthy' ? 100 : githubProvider?.status === 'degraded' ? 50 : 0;
    const leetcodeFreshness = leetcodeProvider?.status === 'healthy' ? 100 : leetcodeProvider?.status === 'degraded' ? 50 : 0;
    const codeforcesFreshness = codeforcesProvider?.status === 'healthy' ? 100 : codeforcesProvider?.status === 'degraded' ? 50 : 0;
    
    const staleProviders = allProviders
      .filter(p => p.status === 'degraded' || p.status === 'down')
      .map(p => p.providerName);
    
    return {
      githubFreshness,
      leetcodeFreshness,
      codeforcesFreshness,
      staleProviders,
    };
  }

  /**
   * Build verified skill data
   */
  private buildVerifiedSkillData(roadmapData: any): VerifiedSkillData {
    if (!roadmapData) {
      return {
        verifiedSkills: [],
        verifiedNodes: [],
        missingDependencies: [],
      };
    }
    
    const verifiedSkills = roadmapData.verifiedNodes?.map((n: any) => n.nodeId) || [];
    const missingDependencies = roadmapData.missingDependencies?.map((d: any) => d.nodeId) || [];
    
    return {
      verifiedSkills,
      verifiedNodes: verifiedSkills,
      missingDependencies,
    };
  }

  /**
   * Get context version
   */
  getContextVersion(): string {
    return this.contextVersion;
  }

  /**
   * Update context version
   */
  updateContextVersion(version: string): void {
    this.contextVersion = version;
    logger.info('[ReadinessContextBuilder] Context version updated', { version });
  }
}

export const ReadinessContextBuilder = new ReadinessContextBuilderClass();
