import { ReadinessRoadmap } from '../../../db/models/readinessRoadmap.model.js';
import { SkillGraphNormalizationLayer, SkillNode } from '../skillGraph/SkillGraphNormalizationLayer.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { SystemDesignSignalExtractor, SystemDesignSignals } from '../intelligence/SystemDesignSignalExtractor.js';
import { logger } from '../../../shared/logger.js';

export interface VerificationInput {
  userId: string;
  targetRole?: string; // e.g., 'Backend Engineer', 'Full Stack Engineer'
}

export interface VerificationEvidence {
  type: 'dependency' | 'file' | 'infra' | 'commit' | 'deployment';
  source: string;
  confidence: number; // 0-100
  description: string;
}

export const SkillNodeVerificationEngine = {
  /**
   * Verify skill nodes using comprehensive proof-of-work evidence mapping.
   * Nodes are ONLY verified through engineering artifacts, never manually.
   */
  async verifyNodes(input: VerificationInput): Promise<void> {
    try {
      const { userId, targetRole } = input;
      
      // Fetch verified projects for evidence extraction
      const verifiedProjects = await VerifiedProject.find({ userId, 'provenance.source': { $exists: false } });
      const hasProjects = verifiedProjects.length > 0;
      
      // Extract system design signals from projects
      const systemDesignSignals = SystemDesignSignalExtractor.extractSignals(verifiedProjects);
      
      // Get the skill graph
      const graph = SkillGraphNormalizationLayer.getGraph();
      
      // Filter graph by target role if specified
      const relevantNodes = targetRole 
        ? SkillGraphNormalizationLayer.getNodesByRole(targetRole)
        : graph;
      
      const verifiedNodes: any[] = [];
      const verifiedNodeIds = new Set<string>();
      const verificationResults = new Map<string, { verified: boolean; evidence: VerificationEvidence[] }>();

      // Deterministically verify nodes based on proof-of-work signals
      for (const node of relevantNodes) {
        const verification = this.verifyNode(node, verifiedProjects, systemDesignSignals);
        verificationResults.set(node.nodeId, verification);
        
        if (verification.verified) {
          verifiedNodes.push({
            nodeId: node.nodeId,
            verifiedAt: new Date(),
            evidenceLinks: verification.evidence.map(e => e.description),
            maturityWeighting: node.maturityWeighting,
            evidence: verification.evidence
          });
          verifiedNodeIds.add(node.nodeId);
        }
      }

      // Find missing dependencies for target role
      const targetNodeId = this.getTargetNodeIdForRole(targetRole);
      const missingDependencies = targetNodeId 
        ? SkillGraphNormalizationLayer.getMissingDependencies(verifiedNodeIds, targetNodeId).map(id => {
            const node = SkillGraphNormalizationLayer.getNode(id);
            return {
              nodeId: id,
              importance: node?.marketRelevance || 'medium',
              reasoning: `Prerequisite for ${targetNodeId}`
            };
          })
        : [];

      // Generate next best actions
      const nextBestActions = this.generateNextBestActions(missingDependencies, verifiedNodeIds);
      
      // Calculate confidence score
      const confidenceScore = this.calculateVerificationConfidence(
        verifiedNodes.length,
        relevantNodes.length,
        verificationResults
      );
      
      const confidenceReasoning = this.generateVerificationReasoning(
        verifiedNodes.length,
        relevantNodes.length,
        hasProjects
      );
      
      const evidenceCoverage = this.calculateEvidenceCoverage(
        verifiedNodes.length,
        verificationResults
      );

      await ReadinessRoadmap.findOneAndUpdate(
        { userId },
        {
          verifiedNodes,
          missingDependencies,
          nextBestActions,
          confidenceScore,
          confidenceReasoning,
          evidenceCoverage,
          snapshotVersion: '1.0.0',
          graphVersion: '1.0.0',
          computedAt: new Date(),
        },
        { upsert: true, new: true }
      );

      logger.info('[SkillNodeVerificationEngine] Verified nodes deterministically', { 
        userId, 
        verifiedCount: verifiedNodes.length,
        totalNodes: relevantNodes.length 
      });
    } catch (error) {
      logger.error('[SkillNodeVerificationEngine] Verification failed', { input, error });
      throw error;
    }
  },

  /**
   * Verify a single skill node using proof-of-work evidence
   */
  verifyNode(
    node: SkillNode,
    projects: any[],
    signals: SystemDesignSignals
  ): { verified: boolean; evidence: VerificationEvidence[] } {
    const evidence: VerificationEvidence[] = [];
    let verified = false;

    // Check project evidence requirement
    if (node.verificationRules.requiresProjectEvidence) {
      if (projects.length === 0) {
        return { verified: false, evidence: [] };
      }
      evidence.push({
        type: 'commit',
        source: 'project-count',
        confidence: 100,
        description: `Has ${projects.length} verified project(s)`
      });
    }

    // Check commit depth requirement
    if (node.verificationRules.requiresCommitDepth) {
      const totalCommits = projects.reduce((sum, p) => sum + (p.commitCount || 0), 0);
      if (totalCommits < node.verificationRules.requiresCommitDepth) {
        return { verified: false, evidence };
      }
      evidence.push({
        type: 'commit',
        source: 'commit-depth',
        confidence: Math.min(100, (totalCommits / node.verificationRules.requiresCommitDepth) * 100),
        description: `Has ${totalCommits} commits (required: ${node.verificationRules.requiresCommitDepth})`
      });
    }

    // Check deployment requirement
    if (node.verificationRules.requiresDeployment) {
      if (!signals.hasDocker) {
        return { verified: false, evidence };
      }
      evidence.push({
        type: 'deployment',
        source: 'docker',
        confidence: 100,
        description: 'Docker deployment detected'
      });
    }

    // Check dependency requirements
    if (node.verificationRules.requiresDependency && node.verificationRules.requiresDependency.length > 0) {
      const depEvidence = this.checkDependencyEvidence(node, projects, signals);
      evidence.push(...depEvidence.evidence);
      if (!depEvidence.satisfied) {
        return { verified: false, evidence };
      }
    }

    // Check infrastructure evidence requirements
    if (node.verificationRules.requiresInfraEvidence && node.verificationRules.requiresInfraEvidence.length > 0) {
      const infraEvidence = this.checkInfraEvidence(node, signals);
      evidence.push(...infraEvidence.evidence);
      if (!infraEvidence.satisfied) {
        return { verified: false, evidence };
      }
    }

    // Check evidence mappings (dependency patterns, file patterns, infra signals)
    const mappingEvidence = this.checkEvidenceMappings(node, projects, signals);
    evidence.push(...mappingEvidence.evidence);
    
    // Node is verified if all checks pass
    verified = true;
    
    return { verified, evidence };
  },

  /**
   * Check dependency evidence for a node
   */
  checkDependencyEvidence(
    node: SkillNode,
    projects: any[],
    signals: SystemDesignSignals
  ): { satisfied: boolean; evidence: VerificationEvidence[] } {
    const evidence: VerificationEvidence[] = [];
    const requiredDeps = node.verificationRules.requiresDependency || [];
    let satisfied = false;

    // Collect all dependencies from projects
    const allDeps = new Set<string>();
    projects.forEach(project => {
      (project.dependencies || []).forEach((dep: string) => allDeps.add(dep.toLowerCase()));
      (project.devDependencies || []).forEach((dep: string) => allDeps.add(dep.toLowerCase()));
    });

    // Check each required dependency
    for (const requiredDep of requiredDeps) {
      const found = Array.from(allDeps).some(dep => dep.includes(requiredDep.toLowerCase()));
      if (found) {
        evidence.push({
          type: 'dependency',
          source: requiredDep,
          confidence: 100,
          description: `Dependency '${requiredDep}' found in projects`
        });
        satisfied = true;
      } else {
        evidence.push({
          type: 'dependency',
          source: requiredDep,
          confidence: 0,
          description: `Dependency '${requiredDep}' not found`
        });
      }
    }

    return { satisfied, evidence };
  },

  /**
   * Check infrastructure evidence for a node
   */
  checkInfraEvidence(
    node: SkillNode,
    signals: SystemDesignSignals
  ): { satisfied: boolean; evidence: VerificationEvidence[] } {
    const evidence: VerificationEvidence[] = [];
    const requiredInfra = node.verificationRules.requiresInfraEvidence || [];
    let satisfied = false;

    for (const infraSignal of requiredInfra) {
      const signalValue = (signals as any)[infraSignal];
      if (signalValue === true) {
        evidence.push({
          type: 'infra',
          source: infraSignal,
          confidence: 100,
          description: `Infrastructure signal '${infraSignal}' detected`
        });
        satisfied = true;
      } else {
        evidence.push({
          type: 'infra',
          source: infraSignal,
          confidence: 0,
          description: `Infrastructure signal '${infraSignal}' not detected`
        });
      }
    }

    return { satisfied, evidence };
  },

  /**
   * Check evidence mappings for a node
   */
  checkEvidenceMappings(
    node: SkillNode,
    projects: any[],
    signals: SystemDesignSignals
  ): { satisfied: boolean; evidence: VerificationEvidence[] } {
    const evidence: VerificationEvidence[] = [];
    let satisfied = false;

    // Check dependency patterns
    if (node.evidenceMappings.dependencyPatterns.length > 0) {
      const allDeps = new Set<string>();
      projects.forEach(project => {
        (project.dependencies || []).forEach((dep: string) => allDeps.add(dep.toLowerCase()));
      });

      for (const pattern of node.evidenceMappings.dependencyPatterns) {
        const found = Array.from(allDeps).some(dep => dep.includes(pattern.toLowerCase()));
        if (found) {
          evidence.push({
            type: 'dependency',
            source: pattern,
            confidence: 100,
            description: `Dependency pattern '${pattern}' matched`
          });
          satisfied = true;
        }
      }
    }

    // Check file patterns
    if (node.evidenceMappings.filePatterns.length > 0) {
      const allFiles = new Set<string>();
      projects.forEach(project => {
        (project.files || []).forEach((file: string) => allFiles.add(file.toLowerCase()));
      });

      for (const pattern of node.evidenceMappings.filePatterns) {
        const found = Array.from(allFiles).some(file => file.includes(pattern.toLowerCase()));
        if (found) {
          evidence.push({
            type: 'file',
            source: pattern,
            confidence: 100,
            description: `File pattern '${pattern}' matched`
          });
          satisfied = true;
        }
      }
    }

    // Check infra signals
    if (node.evidenceMappings.infraSignals.length > 0) {
      for (const signal of node.evidenceMappings.infraSignals) {
        const signalValue = (signals as any)[signal];
        if (signalValue === true) {
          evidence.push({
            type: 'infra',
            source: signal,
            confidence: 100,
            description: `Infrastructure signal '${signal}' detected`
          });
          satisfied = true;
        }
      }
    }

    return { satisfied, evidence };
  },

  /**
   * Get target node ID for a role
   */
  getTargetNodeIdForRole(role?: string): string {
    const roleTargets: Record<string, string> = {
      'Backend Engineer': 'queue-systems',
      'Frontend Engineer': 'state-management',
      'Full Stack Engineer': 'docker-containerization',
      'DevOps Engineer': 'kubernetes-orchestration',
    };
    return role ? (roleTargets[role] || 'docker-containerization') : 'docker-containerization';
  },

  /**
   * Generate next best actions based on missing dependencies
   */
  generateNextBestActions(missingDependencies: any[], verifiedNodeIds: Set<string>): any[] {
    const actions: any[] = [];
    
    // Add actions for missing dependencies
    for (const missing of missingDependencies.slice(0, 3)) {
      const node = SkillGraphNormalizationLayer.getNode(missing.nodeId);
      actions.push({
        actionType: 'build',
        description: `Implement ${node?.name || missing.nodeId} in a project`,
        targetNodeId: missing.nodeId,
        priority: missing.importance
      });
    }
    
    // Add actions for next recommended nodes
    const nextRecommended = SkillGraphNormalizationLayer.getNextRecommendedNodes(verifiedNodeIds, 2);
    for (const node of nextRecommended) {
      actions.push({
        actionType: 'learn',
        description: `Learn ${node.name} (next recommended skill)`,
        targetNodeId: node.nodeId,
        priority: 'medium'
      });
    }
    
    return actions;
  },

  /**
   * Calculate verification confidence score
   */
  calculateVerificationConfidence(
    verifiedCount: number,
    totalCount: number,
    verificationResults: Map<string, { verified: boolean; evidence: VerificationEvidence[] }>
  ): number {
    if (totalCount === 0) return 0;
    
    let confidence = 0;
    
    // Verification ratio contributes
    confidence += (verifiedCount / totalCount) * 50;
    
    // Evidence quality contributes
    let totalEvidenceConfidence = 0;
    let evidenceCount = 0;
    verificationResults.forEach(result => {
      if (result.verified) {
        result.evidence.forEach(e => {
          totalEvidenceConfidence += e.confidence;
          evidenceCount++;
        });
      }
    });
    
    if (evidenceCount > 0) {
      confidence += (totalEvidenceConfidence / evidenceCount) * 0.5;
    }
    
    return Math.min(100, Math.round(confidence));
  },

  /**
   * Generate verification reasoning
   */
  generateVerificationReasoning(
    verifiedCount: number,
    totalCount: number,
    hasProjects: boolean
  ): string {
    const reasons: string[] = [];
    
    if (verifiedCount === totalCount && totalCount > 0) {
      reasons.push('All relevant skills verified');
    } else if (verifiedCount > totalCount / 2) {
      reasons.push('Majority of skills verified');
    } else if (verifiedCount > 0) {
      reasons.push('Partial skill verification');
    } else {
      reasons.push('No skills verified yet');
    }
    
    if (hasProjects) {
      reasons.push('Project evidence available');
    } else {
      reasons.push('No project evidence');
    }
    
    return reasons.join(', ');
  },

  /**
   * Calculate evidence coverage
   */
  calculateEvidenceCoverage(
    verifiedCount: number,
    verificationResults: Map<string, { verified: boolean; evidence: VerificationEvidence[] }>
  ): number {
    if (verifiedCount === 0) return 0;
    
    let totalEvidence = 0;
    let highConfidenceEvidence = 0;
    
    verificationResults.forEach(result => {
      if (result.verified) {
        result.evidence.forEach(e => {
          totalEvidence++;
          if (e.confidence >= 80) highConfidenceEvidence++;
        });
      }
    });
    
    if (totalEvidence === 0) return 0;
    
    return Math.round((highConfidenceEvidence / totalEvidence) * 100);
  },
};
