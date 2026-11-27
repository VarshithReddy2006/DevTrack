import { isObjectIdOrHexString } from 'mongoose';
import { Project } from '../../../db/models/project.model.js';
import { ReadinessRoadmap } from '../../../db/models/readinessRoadmap.model.js';
import { ReadinessSkills } from '../../../db/models/readinessSkills.model.js';
import { ReadinessProjects } from '../../../db/models/readinessProjects.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { UserSkillProgress } from '../../../db/models/userSkillProgress.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { normalizeSkill } from '../role/roleSkills.js';
import { SkillGraphNormalizationLayer } from '../skillGraph/SkillGraphNormalizationLayer.js';
import { logger } from '../../../shared/logger.js';

export interface DynamicRoadmapInput {
  userId: string;
  targetRole?: string;
}

export interface DynamicRoadmapExperience {
  userId: string;
  primaryBlocker: RoadmapBlocker | null;
  blockers: RoadmapBlocker[];
  prioritizedNodes: PrioritizedNode[];
  readinessCriticalSkills: string[];
  roleAlignedProgression: string[];
  dynamicInsights: RoadmapInsight[];
  progressionSummary: string;
  timestamp: Date;
}

export interface RoadmapBlocker {
  nodeId: string;
  nodeName: string;
  type: 'missing-dependency' | 'verified-gap' | 'infrastructure-gap' | 'skill-gap';
  severity: 'critical' | 'high' | 'medium';
  description: string;
  impact: string;
  suggestedActions: string[];
  evidence: string[];
}

export interface PrioritizedNode {
  nodeId: string;
  nodeName: string;
  category: string;
  currentStatus: 'verified' | 'in-progress' | 'blocked' | 'not-started';
  priority: number;
  dependencies: string[];
  estimatedEffort: 'low' | 'medium' | 'high';
  readinessImpact: number; // 0-100
  blocking: boolean;
}

export interface RoadmapInsight {
  type: 'blocker' | 'progression' | 'opportunity' | 'warning';
  message: string;
  context: string;
  actionable: boolean;
}

class DynamicRoadmapExperienceClass {
  /**
   * Generate dynamic roadmap experience
   */
  async generateDynamicRoadmap(input: DynamicRoadmapInput): Promise<DynamicRoadmapExperience> {
    const { userId, targetRole } = input;
    
    try {
      logger.info('[DynamicRoadmapExperience] Generating dynamic roadmap', { userId, targetRole });
      
      // Fetch readiness data & verified skill sources
      const validObjectId = isObjectIdOrHexString(userId);
      const [roadmapData, skillsData, projectsData, resumeProfile, skillProgress, verifiedProjects, projectsList] = await Promise.all([
        ReadinessRoadmap.findOne({ userId }),
        ReadinessSkills.findOne({ userId }),
        ReadinessProjects.findOne({ userId }),
        ResumeProfile.findOne({ userId }).select('selectedSkills').lean(),
        UserSkillProgress.find({ userId, completed: true }).select('skill').lean(),
        validObjectId
          ? VerifiedProject.find({ userId, 'verification.status': 'verified' })
              .select('techStack metrics.primaryLanguage metrics.languages')
              .lean()
          : Promise.resolve([]),
        validObjectId ? Project.find({ userId }).select('techStack').lean() : Promise.resolve([]),
      ]);

      const verifiedSkillSet = new Set<string>([
        ...(resumeProfile?.selectedSkills ?? []),
        ...skillProgress.map(p => p.skill),
        ...projectsList.flatMap(p => p.techStack ?? []),
        ...verifiedProjects.flatMap(vp => [
          ...(vp.techStack ?? []),
          ...(vp.metrics?.primaryLanguage ? [vp.metrics.primaryLanguage] : []),
          ...Object.keys(vp.metrics?.languages ?? {}),
        ]),
      ].map(normalizeSkill).filter(Boolean));
      
      // Identify blockers (excluding dependencies already verified across resume/projects/github)
      const blockers = this.identifyBlockers(roadmapData, skillsData, projectsData)
        .filter(b => !verifiedSkillSet.has(normalizeSkill(b.nodeName)));
      
      // Determine primary blocker
      const primaryBlocker = blockers.length > 0 ? blockers[0] : null;
      
      // Prioritize nodes based on blockers and role
      const prioritizedNodes = this.prioritizeNodes(roadmapData, blockers, targetRole);
      
      // Identify readiness-critical skills
      const readinessCriticalSkills = this.identifyReadinessCriticalSkills(roadmapData, skillsData);
      
      // Identify role-aligned progression
      const roleAlignedProgression = this.identifyRoleAlignedProgression(roadmapData, targetRole);
      
      // Generate dynamic insights
      const dynamicInsights = this.generateDynamicInsights(blockers, prioritizedNodes, targetRole);
      
      // Generate progression summary
      const progressionSummary = this.generateProgressionSummary(primaryBlocker, blockers, targetRole);
      
      const experience: DynamicRoadmapExperience = {
        userId,
        primaryBlocker,
        blockers,
        prioritizedNodes,
        readinessCriticalSkills,
        roleAlignedProgression,
        dynamicInsights,
        progressionSummary,
        timestamp: new Date(),
      };
      
      logger.info('[DynamicRoadmapExperience] Dynamic roadmap generated', { 
        userId, 
        blockerCount: blockers.length,
        primaryBlocker: primaryBlocker?.nodeName 
      });
      
      return experience;
    } catch (error) {
      logger.error('[DynamicRoadmapExperience] Failed to generate dynamic roadmap', { userId, error });
      throw error;
    }
  }

  /**
   * Identify roadmap blockers
   */
  private identifyBlockers(
    roadmapData: any,
    skillsData: any,
    projectsData: any
  ): RoadmapBlocker[] {
    const blockers: RoadmapBlocker[] = [];
    
    // Check for missing dependencies
    if (roadmapData && roadmapData.missingDependencies) {
      roadmapData.missingDependencies.forEach((dep: any) => {
        const skillNode = SkillGraphNormalizationLayer.getNode(dep.nodeId);
        if (!skillNode) return;
        
        const severity = dep.importance === 'high' ? 'critical' : dep.importance === 'medium' ? 'high' : 'medium';
        
        blockers.push({
          nodeId: dep.nodeId,
          nodeName: skillNode.name,
          type: 'missing-dependency',
          severity,
          description: `${skillNode.name} is a missing dependency blocking roadmap progression`,
          impact: `Verifying ${skillNode.name} will unlock ${skillNode.dependencies?.length || 0} additional skills`,
          suggestedActions: [
            `Implement ${skillNode.name} in a project`,
            `Add ${skillNode.name} to your portfolio`,
          ],
          evidence: [
            `Importance: ${dep.importance}`,
            `Reasoning: ${dep.reasoning}`,
          ],
        });
      });
    }
    
    // Check for infrastructure gaps
    if (projectsData && projectsData.systemDesignSignals) {
      const signals = projectsData.systemDesignSignals;
      const missingInfra: string[] = [];
      
      if (!signals.hasRedis) missingInfra.push('Redis caching');
      if (!signals.hasDocker) missingInfra.push('Docker deployment');
      if (!signals.hasBullMQ) missingInfra.push('Queue systems');
      if (!signals.hasMonitoring) missingInfra.push('Monitoring');
      
      missingInfra.forEach(infra => {
        blockers.push({
          nodeId: infra.toLowerCase().replace(/\s+/g, '-'),
          nodeName: infra,
          type: 'infrastructure-gap',
          severity: infra === 'Docker deployment' ? 'critical' : 'high',
          description: `${infra} is not detected in any project, limiting infrastructure maturity`,
          impact: `Adding ${infra} will improve infrastructure sophistication by ~15-20%`,
          suggestedActions: [
            `Implement ${infra} in a backend project`,
            `Document ${infra} implementation`,
          ],
          evidence: [
            `Infrastructure sophistication: ${projectsData.infrastructureSophistication}%`,
            `Missing: ${infra}`,
          ],
        });
      });
    }
    
    // Check for skill gaps
    if (skillsData && skillsData.domains) {
      const weakDomains = skillsData.domains.filter((d: any) => d.maturity < 50 && d.productionRelevance > 70);
      
      weakDomains.forEach((domain: any) => {
        blockers.push({
          nodeId: domain.name.toLowerCase().replace(/\s+/g, '-'),
          nodeName: domain.name,
          type: 'skill-gap',
          severity: domain.productionRelevance > 80 ? 'high' : 'medium',
          description: `${domain.name} domain maturity is ${domain.maturity}%, below the 50% threshold`,
          impact: `Improving ${domain.name} will increase overall engineering depth by ~${(50 - domain.maturity) * 0.3}%`,
          suggestedActions: [
            `Build projects focused on ${domain.name}`,
            `Add ${domain.name} features to existing projects`,
          ],
          evidence: [
            `Current maturity: ${domain.maturity}%`,
            `Production relevance: ${domain.productionRelevance}%`,
            `Practical exposure: ${domain.practicalExposure}%`,
          ],
        });
      });
    }
    
    // Sort blockers by severity
    const severityOrder = { critical: 0, high: 1, medium: 2 };
    return blockers.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }

  /**
   * Prioritize nodes based on blockers and role
   */
  private prioritizeNodes(
    roadmapData: any,
    blockers: RoadmapBlocker[],
    targetRole?: string
  ): PrioritizedNode[] {
    const prioritizedNodes: PrioritizedNode[] = [];
    
    if (!roadmapData) return prioritizedNodes;
    
    // Get all nodes from skill graph
    const allNodes = SkillGraphNormalizationLayer.getGraph();
    
    // Get verified nodes
    const verifiedNodeIds = new Set(roadmapData.verifiedNodes.map((n: any) => n.nodeId));
    
    // Get blocked node IDs
    const blockedNodeIds = new Set(blockers.map(b => b.nodeId));
    
    // Prioritize nodes
    allNodes.forEach((node: any) => {
      const isVerified = verifiedNodeIds.has(node.nodeId);
      const isBlocked = blockedNodeIds.has(node.nodeId);
      const isBlocker = blockers.some(b => b.nodeId === node.nodeId);
      
      // Calculate readiness impact
      const readinessImpact = this.calculateReadinessImpact(node, blockers, targetRole);
      
      // Determine priority
      let priority = 0;
      if (isBlocker) priority += 100;
      if (isBlocked) priority += 50;
      if (!isVerified && !isBlocked) priority += 20;
      
      // Adjust priority based on role alignment
      if (targetRole) {
        priority += this.getRoleAlignmentBonus(node.id, targetRole);
      }
      
      // Determine current status
      let currentStatus: 'verified' | 'in-progress' | 'blocked' | 'not-started';
      if (isVerified) currentStatus = 'verified';
      else if (isBlocked) currentStatus = 'blocked';
      else if (priority > 50) currentStatus = 'in-progress';
      else currentStatus = 'not-started';
      
      // Estimate effort
      const estimatedEffort = this.estimateEffort(node);
      
      prioritizedNodes.push({
        nodeId: node.nodeId,
        nodeName: node.name,
        category: node.category,
        currentStatus,
        priority,
        dependencies: node.dependencies || [],
        estimatedEffort,
        readinessImpact,
        blocking: isBlocker,
      });
    });
    
    // Sort by priority and readiness impact
    return prioritizedNodes.sort((a, b) => {
      const priorityDiff = b.priority - a.priority;
      if (priorityDiff !== 0) return priorityDiff;
      return b.readinessImpact - a.readinessImpact;
    }).slice(0, 20); // Return top 20 nodes
  }

  /**
   * Calculate readiness impact for a node
   */
  private calculateReadinessImpact(node: any, blockers: RoadmapBlocker[], targetRole?: string): number {
    let impact = 50; // Base impact
    
    // Increase impact if node is a blocker
    if (blockers.some(b => b.nodeId === node.id)) {
      impact += 30;
    }
    
    // Increase impact based on number of dependencies
    if (node.dependencies && node.dependencies.length > 0) {
      impact += node.dependencies.length * 5;
    }
    
    // Adjust based on role
    if (targetRole) {
      impact += this.getRoleAlignmentBonus(node.id, targetRole);
    }
    
    return Math.min(100, impact);
  }

  /**
   * Get role alignment bonus
   */
  private getRoleAlignmentBonus(nodeId: string, targetRole: string): number {
    const roleMappings: Record<string, string[]> = {
      'backend-engineer': ['redis', 'docker', 'queue', 'database', 'api', 'deployment'],
      'frontend-engineer': ['react', 'typescript', 'state', 'ui', 'accessibility', 'performance'],
      'full-stack-engineer': ['redis', 'docker', 'react', 'typescript', 'api', 'database'],
      'ml-engineer': ['python', 'ml', 'data', 'model', 'statistics'],
      'systems-engineer': ['redis', 'docker', 'queue', 'monitoring', 'distributed', 'scalability'],
      'product-engineer': ['product', 'ux', 'api', 'testing'],
    };
    
    const roleKeywords = roleMappings[targetRole] || [];
    const nodeLower = nodeId.toLowerCase();
    
    if (roleKeywords.some(keyword => nodeLower.includes(keyword))) {
      return 20;
    }
    
    return 0;
  }

  /**
   * Estimate effort for a node
   */
  private estimateEffort(node: any): 'low' | 'medium' | 'high' {
    if (node.dependencies && node.dependencies.length > 3) return 'high';
    if (node.dependencies && node.dependencies.length > 1) return 'medium';
    return 'low';
  }

  /**
   * Identify readiness-critical skills
   */
  private identifyReadinessCriticalSkills(roadmapData: any, skillsData: any): string[] {
    const criticalSkills: string[] = [];
    
    if (!roadmapData) return criticalSkills;
    
    // Get missing dependencies
    if (roadmapData.missingDependencies) {
      const highImportanceDeps = roadmapData.missingDependencies
        .filter((d: any) => d.importance === 'high')
        .map((d: any) => {
          const node = SkillGraphNormalizationLayer.getNode(d.nodeId);
          return node ? node.name : d.nodeId;
        });
      
      criticalSkills.push(...highImportanceDeps);
    }
    
    // Get weak domains with high production relevance
    if (skillsData && skillsData.domains) {
      const criticalDomains = skillsData.domains
        .filter((d: any) => d.maturity < 50 && d.productionRelevance > 80)
        .map((d: any) => d.name);
      
      criticalSkills.push(...criticalDomains);
    }
    
    return [...new Set(criticalSkills)]; // Remove duplicates
  }

  /**
   * Identify role-aligned progression
   */
  private identifyRoleAlignedProgression(roadmapData: any, targetRole?: string): string[] {
    if (!targetRole) return [];
    
    const roleProgression: Record<string, string[]> = {
      'backend-engineer': ['Redis caching', 'Docker deployment', 'Queue systems', 'API design', 'Database design'],
      'frontend-engineer': ['React optimization', 'TypeScript', 'State management', 'Accessibility', 'Performance'],
      'full-stack-engineer': ['Redis caching', 'Docker deployment', 'API design', 'React', 'Database design'],
      'ml-engineer': ['Python', 'Machine learning', 'Data processing', 'Model deployment', 'Statistics'],
      'systems-engineer': ['Redis caching', 'Docker deployment', 'Queue systems', 'Monitoring', 'Distributed systems'],
      'product-engineer': ['Product thinking', 'API design', 'UX', 'Testing', 'Documentation'],
    };
    
    return roleProgression[targetRole] || [];
  }

  /**
   * Generate dynamic insights
   */
  private generateDynamicInsights(
    blockers: RoadmapBlocker[],
    prioritizedNodes: PrioritizedNode[],
    targetRole?: string
  ): RoadmapInsight[] {
    const insights: RoadmapInsight[] = [];
    
    // Generate blocker insight
    if (blockers.length > 0) {
      const primaryBlocker = blockers[0];
      insights.push({
        type: 'blocker',
        message: `${targetRole ? targetRole.replace('-', ' ').toUpperCase() : 'Roadmap'} progression currently blocked by ${primaryBlocker.nodeName}`,
        context: primaryBlocker.description,
        actionable: true,
      });
    }
    
    // Generate progression insight
    const inProgressNodes = prioritizedNodes.filter(n => n.currentStatus === 'in-progress');
    if (inProgressNodes.length >= 3) {
      insights.push({
        type: 'progression',
        message: `Strong progression momentum with ${inProgressNodes.length} skills in progress`,
        context: 'Continue current focus to maintain momentum',
        actionable: false,
      });
    }
    
    // Generate opportunity insight
    const highImpactNodes = prioritizedNodes.filter(n => n.readinessImpact > 70 && n.currentStatus === 'not-started');
    if (highImpactNodes.length > 0) {
      insights.push({
        type: 'opportunity',
        message: `${highImpactNodes[0].nodeName} represents a high-impact opportunity for readiness improvement`,
        context: `Priority: ${highImpactNodes[0].priority}, Impact: ${highImpactNodes[0].readinessImpact}%`,
        actionable: true,
      });
    }
    
    // Generate warning insight
    const blockedNodes = prioritizedNodes.filter(n => n.currentStatus === 'blocked');
    if (blockedNodes.length > 3) {
      insights.push({
        type: 'warning',
        message: `Multiple blockers (${blockedNodes.length}) detected. Focus on resolving critical blockers first.`,
        context: 'Address high-severity blockers to unblock progression',
        actionable: true,
      });
    }
    
    return insights;
  }

  /**
   * Generate progression summary
   */
  private generateProgressionSummary(
    primaryBlocker: RoadmapBlocker | null,
    blockers: RoadmapBlocker[],
    targetRole?: string
  ): string {
    if (primaryBlocker) {
      return `${targetRole ? targetRole.replace('-', ' ') : 'Roadmap'} progression currently blocked by ${primaryBlocker.nodeName}. Focus on resolving this blocker to unblock ${primaryBlocker.impact.toLowerCase()}.`;
    }
    
    if (blockers.length === 0) {
      return 'No critical blockers detected. Roadmap progression is clear. Continue with current focus areas.';
    }
    
    return `${blockers.length} blockers identified. Address them in order of severity to optimize progression.`;
  }
}

export const DynamicRoadmapExperience = new DynamicRoadmapExperienceClass();
