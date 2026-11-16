// src/modules/resume-intelligence/evidence/EvidenceGraphEngine.ts
import type { Types } from 'mongoose';
import { logger } from '../../../shared/logger.js';
import { ResumeEvidenceClaim, resumeClaimScope } from '../../../db/models/resumeEvidenceClaim.model.js';
import { ClaimLineageResolver } from './ClaimLineageResolver.js';
import { EvidenceRelationshipMapper } from './EvidenceRelationshipMapper.js';
import { VerificationConfidenceEngine } from './VerificationConfidenceEngine.js';

export interface IEvidenceNode {
  id: string;
  type: 'signal' | 'evidence' | 'claim' | 'projection';
  data: any;
  metadata: {
    provenance: string;
    confidence: number;
    timestamp: Date;
  };
}

export interface IEvidenceEdge {
  from: string;
  to: string;
  relationship: string;
  weight: number;
}

/**
 * EvidenceGraphEngine
 * 
 * The intelligence substrate of DevTrack.
 * Manages the graph of signals, evidence, claims, and projections.
 */
export class EvidenceGraphEngine {
  private lineageResolver: ClaimLineageResolver;
  private relationshipMapper: EvidenceRelationshipMapper;
  private confidenceEngine: VerificationConfidenceEngine;

  constructor() {
    this.lineageResolver = new ClaimLineageResolver();
    this.relationshipMapper = new EvidenceRelationshipMapper();
    this.confidenceEngine = new VerificationConfidenceEngine();
  }

  /**
   * Build or update the evidence graph for a user
   */
  async buildGraphForUser(userId: Types.ObjectId): Promise<void> {
    logger.info(`[EvidenceGraph] Building graph for user ${userId}`);
    
    // 1. Resolve claim lineage
    const claims = await ResumeEvidenceClaim.find({ userId, ...resumeClaimScope });
    for (const claim of claims) {
      await this.lineageResolver.resolveLineage(claim);
    }

    // 2. Map relationships
    await this.relationshipMapper.mapRelationships(userId);

    // 3. Update confidence scores
    await this.confidenceEngine.recalculateConfidence(userId);
  }

  /**
   * Get recruiter-facing traceability for a specific claim
   */
  async getTraceability(claimId: string): Promise<{
    lineage: any;
    provenance: any;
    confidence: number;
  }> {
    const claim = await ResumeEvidenceClaim.findOne({ _id: claimId, ...resumeClaimScope });
    if (!claim) throw new Error('Claim not found');

    return {
      lineage: await this.lineageResolver.getLineage(claimId),
      provenance: claim.evidenceSources,
      confidence: claim.confidence,
    };
  }
}
