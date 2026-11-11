import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { VerifiedProjectIngestionService } from '../services/VerifiedProjectIngestionService.js';
import { Project } from '../../../db/models/project.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { SystemDesignSignalExtractor } from './SystemDesignSignalExtractor.js';
import { logger } from '../../../shared/logger.js';
import { differenceInDays, subDays } from 'date-fns';

export interface ProjectIntelligenceInput {
  userId: string;
}

export const ProjectIntelligenceEngine = {
  /**
   * Generates project intelligence with tutorial detection, repository quality analysis,
   * and comprehensive project credibility scoring.
   */
  async generateIntelligence(input: ProjectIntelligenceInput): Promise<void> {
    try {
      const { userId } = input;
      
      const contributorId = await VerifiedProjectIngestionService.ingest(userId);
      const records = await VerifiedProject.find({ userId, 'verification.status': 'verified' }).lean();
      const linkedIds = records.flatMap(record =>
        record.provenance?.linkedRepoUrl && record.projectId ? [record.projectId] : []
      );
      const links = linkedIds.length
        ? await Project.find({ userId, _id: { $in: linkedIds } }).select('repoUrl').lean()
        : [];
      const repoByProjectId = new Map(links.map(link => [String(link._id), link.repoUrl]));
      const activeRecords = records.filter(record => {
        const source = record.provenance;
        if (!source) return true;
        return Boolean(contributorId && source.contributorId === contributorId
          && (source.discoveredBySync || (source.linkedRepoUrl
            && repoByProjectId.get(String(record.projectId)) === source.linkedRepoUrl)));
      });
      const verifiedProjects = activeRecords.map(project => ({
        ...project,
        commitCount: project.metrics?.userCommitCount ?? 0,
        lastCommitAt: project.metrics?.lastCommitAt,
        isFork: project.provenance?.isFork ?? project.verification.checks?.notFork === false,
        fileCount: project.provenance?.fileCount ?? 0,
        files: project.provenance?.files ?? [],
        fileStructure: project.provenance?.files ?? [],
        hasDocumentation: project.provenance?.files.some(file => /(^|\/)readme/i.test(file)) ?? false,
        hasTests: project.provenance?.hasTests ?? false,
      }));
      
      // Detect tutorial projects and cloned repositories
      const projectQualityAnalysis = this.analyzeProjectQuality(verifiedProjects);
      
      // Extract system design signals
      const signals = SystemDesignSignalExtractor.extractSignals(verifiedProjects);
      
      // Calculate architecture sophistication
      const architectureSophistication = this.calculateArchitectureSophistication(signals);
      
      // Calculate deployment evidence
      const deploymentEvidence = this.calculateDeploymentEvidence(signals);
      
      // Calculate project credibility score
      const projectCredibilityScore = this.calculateProjectCredibilityScore(
        verifiedProjects,
        projectQualityAnalysis,
        architectureSophistication
      );
      
      // Calculate engineering maturity
      const engineeringMaturity = this.calculateEngineeringMaturity(
        architectureSophistication,
        deploymentEvidence,
        projectQualityAnalysis
      );
      
      // Calculate infrastructure sophistication
      const infrastructureSophistication = this.calculateInfrastructureSophistication(signals);
      
      // Calculate complexity metrics
      const complexityMetrics = this.calculateComplexityMetrics(
        verifiedProjects,
        signals,
        projectQualityAnalysis
      );
      
      // Calculate communication signals
      const communicationSignals = this.calculateCommunicationSignals(verifiedProjects);
      
      // Calculate confidence score
      const confidenceScore = this.calculateConfidenceScore(
        verifiedProjects.length,
        projectQualityAnalysis.nonTutorialCount,
        deploymentEvidence
      );
      
      const confidenceReasoning = this.generateConfidenceReasoning(
        verifiedProjects.length,
        projectQualityAnalysis.nonTutorialCount,
        projectQualityAnalysis.tutorialCount,
        deploymentEvidence
      );
      
      const evidenceCoverage = this.calculateEvidenceCoverage(
        verifiedProjects.length,
        projectQualityAnalysis.repositoryQualityScore,
        signals
      );
      
      const providerFreshness = this.calculateProviderFreshness(verifiedProjects);
      
      await ReadinessProjects.findOneAndUpdate(
        { userId },
        {
          projectCredibilityScore,
          infrastructureSophistication,
          engineeringMaturity,
          deploymentEvidence,
          complexityMetrics,
          systemDesignSignals: signals,
          communicationSignals,
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

      logger.info('[ProjectIntelligenceEngine] Successfully generated project intelligence', { userId });
    } catch (error) {
      logger.error('[ProjectIntelligenceEngine] Failed to generate intelligence', { input, error });
      throw error;
    }
  },

  /**
   * Analyze project quality to detect tutorials, clones, and shallow repos
   */
  analyzeProjectQuality(projects: any[]): {
    tutorialCount: number;
    cloneCount: number;
    shallowRepoCount: number;
    inactiveProjectCount: number;
    nonTutorialCount: number;
    repositoryQualityScore: number;
    averageCommitCount: number;
    averageFileCount: number;
  } {
    let tutorialCount = 0;
    let cloneCount = 0;
    let shallowRepoCount = 0;
    let inactiveProjectCount = 0;
    let totalCommits = 0;
    let totalFiles = 0;
    let qualityScoreSum = 0;
    
    const thirtyDaysAgo = subDays(new Date(), 30);
    
    projects.forEach(project => {
      // Detect tutorial projects (common patterns)
      const isTutorial = this.detectTutorialProject(project);
      if (isTutorial) tutorialCount++;
      
      // Detect cloned repositories
      const isClone = this.detectClonedRepository(project);
      if (isClone) cloneCount++;
      
      // Detect shallow repos (low commit count, few files)
      const isShallow = this.detectShallowRepository(project);
      if (isShallow) shallowRepoCount++;
      
      // Detect inactive projects (no recent commits)
      const lastCommit = project.lastCommitAt ? new Date(project.lastCommitAt) : null;
      if (!lastCommit || lastCommit < thirtyDaysAgo) {
        inactiveProjectCount++;
      }
      
      // Aggregate metrics
      totalCommits += project.commitCount || 0;
      totalFiles += project.fileCount || 0;
      qualityScoreSum += this.calculateIndividualProjectQuality(project);
    });
    
    const nonTutorialCount = projects.length - tutorialCount;
    const averageCommitCount = projects.length > 0 ? totalCommits / projects.length : 0;
    const averageFileCount = projects.length > 0 ? totalFiles / projects.length : 0;
    const repositoryQualityScore = projects.length > 0 ? qualityScoreSum / projects.length : 0;
    
    return {
      tutorialCount,
      cloneCount,
      shallowRepoCount,
      inactiveProjectCount,
      nonTutorialCount,
      repositoryQualityScore,
      averageCommitCount,
      averageFileCount,
    };
  },

  /**
   * Detect tutorial projects based on common patterns
   */
  detectTutorialProject(project: any): boolean {
    const tutorialKeywords = ['tutorial', 'demo', 'example', 'sample', 'starter', 'template', 'boilerplate'];
    const name = project.name?.toLowerCase() || '';
    const description = project.description?.toLowerCase() || '';
    
    // Check for tutorial keywords in name or description
    const hasTutorialKeyword = tutorialKeywords.some(keyword => 
      name.includes(keyword) || description.includes(keyword)
    );
    
    // Check for tutorial-like file structures
    const hasTutorialStructure = project.fileStructure?.some((file: string) => 
      file.includes('tutorial') || file.includes('example')
    );
    
    // Check for low complexity (very few commits, simple structure)
    const isLowComplexity = (project.commitCount || 0) < 5 && (project.fileCount || 0) < 10;
    
    return hasTutorialKeyword || hasTutorialStructure || isLowComplexity;
  },

  /**
   * Detect cloned repositories
   */
  detectClonedRepository(project: any): boolean {
    // Check for fork indicators
    const isFork = project.isFork === true;
    
    // Check for identical commit patterns (simplified)
    const hasGenericCommits = project.commitMessages?.some((msg: string) => 
      msg.toLowerCase().includes('initial commit') && 
      (project.commitCount || 0) < 3
    );
    
    // Check for generic README
    const hasGenericReadme = project.readmeContent?.length < 100;
    
    return isFork || hasGenericCommits || hasGenericReadme;
  },

  /**
   * Detect shallow repositories
   */
  detectShallowRepository(project: any): boolean {
    const commitCount = project.commitCount || 0;
    const fileCount = project.fileCount || 0;
    
    // Shallow repos have very few commits and files
    return commitCount < 10 && fileCount < 20;
  },

  /**
   * Calculate individual project quality score
   */
  calculateIndividualProjectQuality(project: any): number {
    let score = 0;
    
    // Commit depth contributes
    score += Math.min(30, (project.commitCount || 0) * 2);
    
    // File structure contributes
    score += Math.min(20, (project.fileCount || 0) * 1);
    
    // Documentation contributes
    if (project.hasDocumentation) score += 20;
    
    // Tests contribute
    if (project.hasTests) score += 15;
    
    // README quality contributes
    const readmeLength = project.readmeContent?.length || 0;
    score += Math.min(15, readmeLength / 100);
    
    return Math.min(100, score);
  },

  /**
   * Calculate architecture sophistication from system design signals
   */
  calculateArchitectureSophistication(signals: any): number {
    let sophistication = 0;
    
    if (signals.hasCaching) sophistication += 30;
    if (signals.hasQueueSystems) sophistication += 40;
    if (signals.hasSSEWebSockets) sophistication += 30;
    if (signals.hasRedis) sophistication += 25;
    if (signals.hasBullMQ) sophistication += 25;
    if (signals.hasMonitoring) sophistication += 20;
    
    return Math.min(100, sophistication);
  },

  /**
   * Calculate deployment evidence from signals
   */
  calculateDeploymentEvidence(signals: any): number {
    let evidence = 0;
    
    if (signals.hasDocker) evidence += 40;
    if (signals.hasDeploymentPipelines) evidence += 40;
    if (signals.hasInfraOrchestration) evidence += 20;
    if (signals.hasCDN) evidence += 15;
    
    return Math.min(100, evidence);
  },

  /**
   * Calculate project credibility score
   */
  calculateProjectCredibilityScore(
    projects: any[],
    qualityAnalysis: any,
    architectureSophistication: number
  ): number {
    if (projects.length === 0) return 0;
    
    let credibility = 0;
    
    // Non-tutorial project count contributes
    credibility += Math.min(40, qualityAnalysis.nonTutorialCount * 15);
    
    // Repository quality contributes
    credibility += qualityAnalysis.repositoryQualityScore * 0.3;
    
    // Architecture sophistication contributes
    credibility += architectureSophistication * 0.3;
    
    // Penalize for high tutorial ratio
    const tutorialRatio = qualityAnalysis.tutorialCount / projects.length;
    if (tutorialRatio > 0.5) credibility *= 0.5;
    else if (tutorialRatio > 0.3) credibility *= 0.7;
    
    return Math.min(100, Math.round(credibility));
  },

  /**
   * Calculate engineering maturity
   */
  calculateEngineeringMaturity(
    architectureSophistication: number,
    deploymentEvidence: number,
    qualityAnalysis: any
  ): number {
    let maturity = 0;
    
    // Architecture sophistication contributes
    maturity += architectureSophistication * 0.4;
    
    // Deployment evidence contributes
    maturity += deploymentEvidence * 0.3;
    
    // Repository quality contributes
    maturity += qualityAnalysis.repositoryQualityScore * 0.2;
    
    // Commit consistency contributes
    maturity += Math.min(10, qualityAnalysis.averageCommitCount * 0.5);
    
    return Math.round(maturity);
  },

  /**
   * Calculate infrastructure sophistication
   */
  calculateInfrastructureSophistication(signals: any): number {
    let sophistication = 0;
    
    if (signals.hasDocker) sophistication += 25;
    if (signals.hasRedis) sophistication += 20;
    if (signals.hasBullMQ) sophistication += 20;
    if (signals.hasQueueSystems) sophistication += 15;
    if (signals.hasMonitoring) sophistication += 10;
    if (signals.hasCDN) sophistication += 10;
    
    return Math.min(100, sophistication);
  },

  /**
   * Calculate complexity metrics
   */
  calculateComplexityMetrics(
    projects: any[],
    signals: any,
    qualityAnalysis: any
  ): any {
    return {
      architectureSophistication: this.calculateArchitectureSophistication(signals),
      scalabilityExposure: signals.hasQueueSystems || signals.hasCaching ? 80 : 0,
      repositoryQuality: qualityAnalysis.repositoryQualityScore,
      contributionConsistency: Math.min(100, qualityAnalysis.averageCommitCount * 5),
      operationalComplexity: signals.hasMonitoring ? 90 : 30,
      tutorialRatio: projects.length > 0 ? qualityAnalysis.tutorialCount / projects.length : 0,
      cloneRatio: projects.length > 0 ? qualityAnalysis.cloneCount / projects.length : 0,
    };
  },

  /**
   * Calculate communication signals
   */
  calculateCommunicationSignals(projects: any[]): any {
    let totalReadmeLength = 0;
    let hasDocumentationCount = 0;
    
    projects.forEach(project => {
      totalReadmeLength += project.readmeContent?.length || 0;
      if (project.hasDocumentation) hasDocumentationCount++;
    });
    
    const averageReadmeLength = projects.length > 0 ? totalReadmeLength / projects.length : 0;
    const documentationQuality = Math.min(100, averageReadmeLength / 10);
    const technicalExplanationClarity = projects.length ? hasDocumentationCount / projects.length * 100 : 0;
    const communicationMaturity = (documentationQuality + technicalExplanationClarity) / 2;
    
    return {
      documentationQuality,
      technicalExplanationClarity,
      communicationMaturity,
    };
  },

  /**
   * Calculate confidence score
   */
  calculateConfidenceScore(
    projectCount: number,
    nonTutorialCount: number,
    deploymentEvidence: number
  ): number {
    let confidence = 0;
    
    // Project volume contributes
    confidence += Math.min(30, projectCount * 10);
    
    // Non-tutorial ratio contributes
    const nonTutorialRatio = projectCount > 0 ? nonTutorialCount / projectCount : 0;
    confidence += nonTutorialRatio * 40;
    
    // Deployment evidence contributes
    confidence += deploymentEvidence * 0.3;
    
    return Math.min(100, Math.round(confidence));
  },

  /**
   * Generate confidence reasoning
   */
  generateConfidenceReasoning(
    projectCount: number,
    nonTutorialCount: number,
    tutorialCount: number,
    deploymentEvidence: number
  ): string {
    const reasons: string[] = [];
    
    if (projectCount > 3) reasons.push('Multiple verified projects');
    else if (projectCount > 0) reasons.push('Limited project count');
    else reasons.push('No verified projects');
    
    if (tutorialCount === 0) reasons.push('No tutorial projects detected');
    else if (tutorialCount < projectCount / 2) reasons.push('Some tutorial projects detected');
    else reasons.push('High tutorial project ratio');
    
    if (deploymentEvidence > 50) reasons.push('Strong deployment evidence');
    else if (deploymentEvidence > 0) reasons.push('Limited deployment evidence');
    else reasons.push('No deployment evidence');
    
    return reasons.join(', ');
  },

  /**
   * Calculate evidence coverage
   */
  calculateEvidenceCoverage(
    projectCount: number,
    repositoryQualityScore: number,
    signals: any
  ): number {
    let coverage = 0;
    
    // Project evidence
    coverage += Math.min(30, projectCount * 10);
    
    // Repository quality evidence
    coverage += repositoryQualityScore * 0.3;
    
    // System design signals evidence
    let signalCount = 0;
    Object.values(signals).forEach((value: any) => {
      if (value === true) signalCount++;
    });
    coverage += Math.min(40, signalCount * 10);
    
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
          const updatedAt = p.provenance?.checkedAt ?? p.updatedAt ?? new Date(0);
          return updatedAt > latest ? updatedAt : latest;
        }, new Date(0))
      : new Date(0);
    
    const daysSinceSync = differenceInDays(new Date(), lastSync);
    const freshnessScore = Math.max(0, 100 - (daysSinceSync * 2));
    
    return { lastSync, freshnessScore };
  },
};
