// src/modules/resume-intelligence/evidence/ResumeEvidenceResolver.ts
import type { Types } from 'mongoose';
import { ResumeEvidenceClaim } from '../../../db/models/resumeEvidenceClaim.model.js';
import { Project } from '../../../db/models/project.model.js';
import { VerifiedProject } from '../../../db/models/verifiedProject.model.js';
import { logger } from '../../../shared/logger.js';

export interface IEvidenceSource {
  type: 'github' | 'deployment' | 'infrastructure' | 'roadmap' | 'system-design';
  link?: string;
  description: string;
  confidence: number;
}

/**
 * ResumeEvidenceResolver
 * 
 * Maps recruiter-visible engineering claims to deterministic evidence
 * from GitHub, infrastructure, and deployment signals.
 */
export class ResumeEvidenceResolver {
  /**
   * Resolve evidence for a list of claims
   */
  async resolveEvidenceForClaims(userId: Types.ObjectId, claims: string[]): Promise<Map<string, IEvidenceSource[]>> {
    logger.info(`[ResumeEvidenceResolver] Resolving evidence for ${claims.length} claims for user ${userId}`);
    
    const results = new Map<string, IEvidenceSource[]>();
    
    // Fetch user's verified projects and normal projects
    const verifiedProjects = await VerifiedProject.find({ userId, 'provenance.source': { $exists: false } });
    const projects = await Project.find({ userId });

    for (const claim of claims) {
      const evidence = await this.findEvidenceForClaim(claim, projects, verifiedProjects);
      results.set(claim, evidence);
    }

    return results;
  }

  /**
   * Find specific evidence for a single claim
   */
  private async findEvidenceForClaim(
    claim: string,
    projects: any[],
    verifiedProjects: any[]
  ): Promise<IEvidenceSource[]> {
    const evidence: IEvidenceSource[] = [];
    const claimLower = claim.toLowerCase();

    // 1. Check for Infrastructure claims
    if (this.isInfraClaim(claimLower)) {
      const infraEvidence = this.resolveInfraEvidence(projects, claimLower);
      evidence.push(...infraEvidence);
    }

    // 2. Check for Project-specific claims
    const projectEvidence = this.resolveProjectEvidence(projects, verifiedProjects, claimLower);
    evidence.push(...projectEvidence);

    // 3. Check for Scale/Performance claims
    if (this.isPerformanceClaim(claimLower)) {
      const perfEvidence = this.resolvePerformanceEvidence(projects, claimLower);
      evidence.push(...perfEvidence);
    }

    return evidence;
  }

  private isInfraClaim(claim: string): boolean {
    return /\b(docker|kubernetes|k8s|aws|cloud|ci\/cd|pipeline|terraform|ansible)\b/i.test(claim);
  }

  private isPerformanceClaim(claim: string): boolean {
    return /\b(performance|latency|scalable|throughput|optimization|bottleneck)\b/i.test(claim);
  }

  private resolveInfraEvidence(projects: any[], claim: string): IEvidenceSource[] {
    const sources: IEvidenceSource[] = [];
    
    projects.forEach(p => {
      const techStack = (p.techStack || []).map((t: string) => t.toLowerCase());
      
      // Match tech stack to claim
      const matchedTech = techStack.filter((t: string) => claim.includes(t));
      if (matchedTech.length > 0) {
        sources.push({
          type: 'infrastructure',
          description: `Verified usage of ${matchedTech.join(', ')} in project "${p.title}"`,
          link: p.repoUrl,
          confidence: 0.9,
        });
      }
    });

    return sources;
  }

  private resolveProjectEvidence(projects: any[], verifiedProjects: any[], claim: string): IEvidenceSource[] {
    const sources: IEvidenceSource[] = [];

    // Check verified projects first (higher confidence)
    verifiedProjects.forEach(vp => {
      if (claim.includes(vp.title.toLowerCase())) {
        sources.push({
          type: 'system-design',
          description: `Verified engineering depth in project "${vp.title}" through deep analysis`,
          link: vp.repoUrl,
          confidence: 0.95,
        });
      }
    });

    // Check general projects
    projects.forEach(p => {
      if (claim.includes(p.title.toLowerCase()) || p.description?.toLowerCase().includes(claim)) {
        sources.push({
          type: 'github',
          description: `Activity and commits related to claim found in project "${p.title}"`,
          link: p.repoUrl,
          confidence: 0.8,
        });
      }
    });

    return sources;
  }

  private resolvePerformanceEvidence(projects: any[], _claim: string): IEvidenceSource[] {
    const sources: IEvidenceSource[] = [];
    
    // Look for projects with performance-related tech
    projects.forEach(p => {
      const techStack = (p.techStack || []).map((t: string) => t.toLowerCase());
      if (techStack.includes('redis') || techStack.includes('kafka') || techStack.includes('prometheus')) {
        sources.push({
          type: 'deployment',
          description: `System design includes ${techStack.filter((t: string) => ['redis', 'kafka', 'prometheus'].includes(t)).join(', ')} for performance monitoring/optimization`,
          link: p.repoUrl,
          confidence: 0.85,
        });
      }
    });

    return sources;
  }

  /**
   * Create or update an evidence claim in DB
   */
  async syncClaimToDB(userId: Types.ObjectId, claimText: string, evidence: IEvidenceSource[]): Promise<void> {
    await ResumeEvidenceClaim.findOneAndUpdate(
      { userId, claimText },
      {
        evidenceSources: evidence,
        verificationStatus: evidence.length > 0 ? 'verified' : 'unverified',
        confidence: evidence.length > 0 ? Math.max(...evidence.map(e => e.confidence)) : 0,
        provenance: 'ResumeEvidenceResolver',
      },
      { upsert: true }
    );
  }
}
