import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { getActiveVerifiedProjects } from '../services/activeVerifiedProjects.js';
import { logger } from '../../../shared/logger.js';
import { differenceInDays, subDays } from 'date-fns';

export interface SkillIntelligenceInput {
  userId: string;
}

export const SkillIntelligenceEngine = {
  /**
   * Generates skill maturity intelligence from verified projects and activity.
   * Analyzes dependency extraction, deployment metadata, repository analysis,
   * infra usage, and commit history to determine practical exposure and engineering depth.
   */
  async generateIntelligence(input: SkillIntelligenceInput): Promise<void> {
    try {
      const { userId } = input;
      
      // Fetch verified projects for dependency extraction
      const verifiedProjects = await getActiveVerifiedProjects(userId);
      
      // Extract dependencies from all projects
      const dependencyMap = this.extractDependencies(verifiedProjects);
      
      // Analyze deployment metadata
      const deploymentSignals = this.analyzeDeploymentMetadata(verifiedProjects);
      
      // Analyze repository quality
      const repositoryQuality = this.analyzeRepositoryQuality(verifiedProjects);
      
      // Analyze commit consistency
      const commitConsistency = this.analyzeCommitConsistency(verifiedProjects);
      
      // Analyze infrastructure usage
      const infraUsage = this.analyzeInfraUsage(verifiedProjects);
      
      // Process domains (frontend, backend, databases, cloud, devops, etc.)
      const domains = this.processDomains(
        dependencyMap,
        deploymentSignals,
        repositoryQuality,
        commitConsistency,
        infraUsage
      );
      
      // Calculate overall engineering depth
      const overallEngineeringDepth = this.calculateOverallEngineeringDepth(domains);
      
      // Calculate confidence score
      const confidenceScore = this.calculateConfidenceScore(
        verifiedProjects.length,
        domains.length,
        deploymentSignals.hasDeploymentEvidence
      );
      
      const confidenceReasoning = this.generateConfidenceReasoning(
        verifiedProjects.length,
        domains.length,
        deploymentSignals.hasDeploymentEvidence
      );
      
      const evidenceCoverage = this.calculateEvidenceCoverage(
        verifiedProjects.length,
        dependencyMap.size,
        deploymentSignals.deploymentCount
      );
      
      const providerFreshness = this.calculateProviderFreshness(verifiedProjects);
      
      await ReadinessSkills.findOneAndUpdate(
        { userId },
        {
          domains,
          overallEngineeringDepth,
          confidenceScore,
          confidenceReasoning,
          evidenceCoverage,
          providerFreshness: { github: providerFreshness },
          snapshotVersion: '1.0.0',
          analyticsVersion: '1.0.0',
          computedAt: new Date(),
        },
        { upsert: true, new: true }
      );

      logger.info('[SkillIntelligenceEngine] Successfully generated skill intelligence', { userId });
    } catch (error) {
      logger.error('[SkillIntelligenceEngine] Failed to generate intelligence', { input, error });
      throw error;
    }
  },

  /**
   * Extract dependencies from verified projects
   */
  extractDependencies(projects: any[]): Map<string, { count: number; projects: string[] }> {
    const dependencyMap = new Map<string, { count: number; projects: string[] }>();
    
    projects.forEach(project => {
      const dependencies = project.dependencies || [];
      dependencies.forEach((dep: string) => {
        const normalizedDep = dep.toLowerCase();
        if (!dependencyMap.has(normalizedDep)) {
          dependencyMap.set(normalizedDep, { count: 0, projects: [] });
        }
        const entry = dependencyMap.get(normalizedDep)!;
        entry.count++;
        entry.projects.push(project.name);
      });
    });
    
    return dependencyMap;
  },

  /**
   * Analyze deployment metadata from projects
   */
  analyzeDeploymentMetadata(projects: any[]): {
    hasDeploymentEvidence: boolean;
    deploymentCount: number;
    deploymentPlatforms: string[];
    hasDocker: boolean;
    hasCI: boolean;
  } {
    let deploymentCount = 0;
    const deploymentPlatforms = new Set<string>();
    let hasDocker = false;
    let hasCI = false;
    
    projects.forEach(project => {
      if (project.deploymentMetadata) {
        deploymentCount++;
        if (project.deploymentMetadata.platform) {
          deploymentPlatforms.add(project.deploymentMetadata.platform);
        }
        if (project.deploymentMetadata.hasDocker) hasDocker = true;
        if (project.deploymentMetadata.hasCI) hasCI = true;
      }
    });
    
    return {
      hasDeploymentEvidence: deploymentCount > 0,
      deploymentCount,
      deploymentPlatforms: Array.from(deploymentPlatforms),
      hasDocker,
      hasCI,
    };
  },

  /**
   * Analyze repository quality metrics
   */
  analyzeRepositoryQuality(projects: any[]): {
    averageCommitCount: number;
    averageFileCount: number;
    hasDocumentation: boolean;
    hasTests: boolean;
  } {
    let totalCommits = 0;
    let totalFiles = 0;
    let hasDocumentation = false;
    let hasTests = false;
    
    projects.forEach(project => {
      totalCommits += project.commitCount || 0;
      totalFiles += project.fileCount || 0;
      if (project.hasDocumentation) hasDocumentation = true;
      if (project.hasTests) hasTests = true;
    });
    
    return {
      averageCommitCount: projects.length > 0 ? totalCommits / projects.length : 0,
      averageFileCount: projects.length > 0 ? totalFiles / projects.length : 0,
      hasDocumentation,
      hasTests,
    };
  },

  /**
   * Analyze commit consistency patterns
   */
  analyzeCommitConsistency(projects: any[]): {
    activeProjects: number;
    recentActivity: number;
    consistencyScore: number;
  } {
    const now = new Date();
    const thirtyDaysAgo = subDays(now, 30);
    
    let activeProjects = 0;
    let recentActivity = 0;
    
    projects.forEach(project => {
      const lastCommit = project.lastCommitAt ? new Date(project.lastCommitAt) : null;
      if (lastCommit && lastCommit > thirtyDaysAgo) {
        activeProjects++;
        recentActivity++;
      }
    });
    
    const consistencyScore = projects.length > 0 
      ? Math.min(100, (activeProjects / projects.length) * 100)
      : 0;
    
    return { activeProjects, recentActivity, consistencyScore };
  },

  /**
   * Analyze infrastructure usage patterns
   */
  analyzeInfraUsage(projects: any[]): {
    usesCloud: boolean;
    usesDatabase: boolean;
    usesCaching: boolean;
    usesQueues: boolean;
    usesMonitoring: boolean;
  } {
    let usesCloud = false;
    let usesDatabase = false;
    let usesCaching = false;
    let usesQueues = false;
    let usesMonitoring = false;
    
    projects.forEach(project => {
      const infra = project.infrastructure || {};
      if (infra.cloud) usesCloud = true;
      if (infra.database) usesDatabase = true;
      if (infra.caching) usesCaching = true;
      if (infra.queues) usesQueues = true;
      if (infra.monitoring) usesMonitoring = true;
    });
    
    return { usesCloud, usesDatabase, usesCaching, usesQueues, usesMonitoring };
  },

  /**
   * Process skill domains based on extracted signals
   */
  processDomains(
    dependencyMap: Map<string, { count: number; projects: string[] }>,
    deploymentSignals: any,
    repositoryQuality: any,
    commitConsistency: any,
    infraUsage: any
  ): any[] {
    const domains: any[] = [];
    
    // Define domain skill mappings
    const domainSkillMappings: Record<string, string[]> = {
      'frontend': ['react', 'vue', 'angular', 'typescript', 'javascript', 'css', 'tailwind', 'next'],
      'backend': ['express', 'nestjs', 'django', 'flask', 'spring', 'fastapi', 'node'],
      'databases': ['mongodb', 'postgresql', 'mysql', 'redis', 'elasticsearch', 'prisma', 'typeorm'],
      'cloud': ['aws', 'gcp', 'azure', 'vercel', 'netlify', 'docker', 'kubernetes'],
      'devops': ['github-actions', 'jenkins', 'terraform', 'ansible', 'ci-cd'],
      'infrastructure': ['nginx', 'apache', 'rabbitmq', 'bullmq', 'sqs'],
    };
    
    Object.entries(domainSkillMappings).forEach(([domainName, skills]) => {
      const verifiedSkills: string[] = [];
      const missingSkills: string[] = [];
      let skillCount = 0;
      
      skills.forEach(skill => {
        const normalizedSkill = skill.toLowerCase();
        if (dependencyMap.has(normalizedSkill)) {
          verifiedSkills.push(skill);
          skillCount += dependencyMap.get(normalizedSkill)!.count;
        } else {
          missingSkills.push(skill);
        }
      });
      
      if (verifiedSkills.length > 0) {
        const maturity = this.calculateDomainMastery(
          verifiedSkills.length,
          skillCount,
          deploymentSignals.hasDeploymentEvidence,
          repositoryQuality.averageCommitCount
        );
        
        const practicalExposure = this.calculatePracticalExposure(
          skillCount,
          commitConsistency.consistencyScore
        );
        
        const productionRelevance = this.calculateProductionRelevance(
          deploymentSignals.hasDeploymentEvidence,
          infraUsage.usesCloud,
          infraUsage.usesDatabase
        );
        
        const consistency = commitConsistency.consistencyScore;
        
        domains.push({
          name: domainName,
          maturity,
          practicalExposure,
          productionRelevance,
          recency: new Date(),
          consistency,
          verifiedSkills,
          missingSkills,
        });
      }
    });
    
    return domains;
  },

  /**
   * Calculate domain maturity score
   */
  calculateDomainMastery(
    verifiedSkillCount: number,
    totalUsage: number,
    hasDeployment: boolean,
    commitCount: number
  ): number {
    let maturity = 0;
    
    // Skill diversity contributes
    maturity += Math.min(40, verifiedSkillCount * 10);
    
    // Usage depth contributes
    maturity += Math.min(30, totalUsage * 5);
    
    // Deployment evidence contributes
    if (hasDeployment) maturity += 20;
    
    // Commit depth contributes
    maturity += Math.min(10, commitCount * 0.5);
    
    return Math.min(100, Math.round(maturity));
  },

  /**
   * Calculate practical exposure score
   */
  calculatePracticalExposure(totalUsage: number, consistencyScore: number): number {
    let exposure = 0;
    
    // Usage volume contributes
    exposure += Math.min(50, totalUsage * 10);
    
    // Consistency contributes
    exposure += consistencyScore * 0.5;
    
    return Math.min(100, Math.round(exposure));
  },

  /**
   * Calculate production relevance score
   */
  calculateProductionRelevance(
    hasDeployment: boolean,
    usesCloud: boolean,
    usesDatabase: boolean
  ): number {
    let relevance = 0;
    
    if (hasDeployment) relevance += 40;
    if (usesCloud) relevance += 30;
    if (usesDatabase) relevance += 30;
    
    return relevance;
  },

  /**
   * Calculate overall engineering depth
   */
  calculateOverallEngineeringDepth(domains: any[]): number {
    if (domains.length === 0) return 0;
    
    const totalMaturity = domains.reduce((sum, d) => sum + d.maturity, 0);
    return Math.round(totalMaturity / domains.length);
  },

  /**
   * Calculate confidence score
   */
  calculateConfidenceScore(
    projectCount: number,
    domainCount: number,
    hasDeployment: boolean
  ): number {
    let confidence = 0;
    
    // Project volume contributes
    confidence += Math.min(30, projectCount * 10);
    
    // Domain diversity contributes
    confidence += Math.min(30, domainCount * 10);
    
    // Deployment evidence contributes
    if (hasDeployment) confidence += 40;
    
    return Math.min(100, confidence);
  },

  /**
   * Generate confidence reasoning
   */
  generateConfidenceReasoning(
    projectCount: number,
    domainCount: number,
    hasDeployment: boolean
  ): string {
    const reasons: string[] = [];
    
    if (projectCount > 3) reasons.push('Multiple verified projects');
    else if (projectCount > 0) reasons.push('Limited project count');
    else reasons.push('No verified projects');
    
    if (domainCount > 3) reasons.push('Diverse domain coverage');
    else if (domainCount > 0) reasons.push('Moderate domain coverage');
    else reasons.push('No domain coverage');
    
    if (hasDeployment) reasons.push('Production deployment evidence');
    else reasons.push('No deployment evidence');
    
    return reasons.join(', ');
  },

  /**
   * Calculate evidence coverage
   */
  calculateEvidenceCoverage(
    projectCount: number,
    dependencyCount: number,
    deploymentCount: number
  ): number {
    let coverage = 0;
    
    // Project evidence
    coverage += Math.min(40, projectCount * 15);
    
    // Dependency evidence
    coverage += Math.min(30, dependencyCount * 2);
    
    // Deployment evidence
    coverage += Math.min(30, deploymentCount * 30);
    
    return Math.min(100, Math.round(coverage));
  },

  /**
   * Calculate provider freshness
   */
  calculateProviderFreshness(projects: any[]): {
    lastSync: Date;
    freshnessScore: number;
  } {
    const lastSync = projects.length > 0
      ? projects.reduce((latest, p) => {
          const updatedAt = p.updatedAt ? new Date(p.updatedAt) : new Date(0);
          return updatedAt > latest ? updatedAt : latest;
        }, new Date(0))
      : new Date(0);
    
    const daysSinceSync = differenceInDays(new Date(), lastSync);
    const freshnessScore = Math.max(0, 100 - (daysSinceSync * 2));
    
    return { lastSync, freshnessScore };
  },
};
