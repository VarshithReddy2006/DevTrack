import { isDeepStrictEqual } from 'node:util';
import type { Types } from 'mongoose';
import { ResumeEvidenceClaim, resumeClaimScope } from '../../../db/models/resumeEvidenceClaim.model.js';
import { ClaimLineageResolver } from './ClaimLineageResolver.js';
import { EvidenceRelationshipMapper } from './EvidenceRelationshipMapper.js';
import { VerificationConfidenceEngine } from './VerificationConfidenceEngine.js';

export class EvidenceGraphEngine {
  private readonly lineageResolver = new ClaimLineageResolver();
  private readonly relationshipMapper = new EvidenceRelationshipMapper();
  private readonly confidenceEngine = new VerificationConfidenceEngine();

  async buildGraphForUser(userId: Types.ObjectId): Promise<void> {
    const claims = await ResumeEvidenceClaim.find({ userId, ...resumeClaimScope })
      .select('_id evidenceSources +lineage confidence verificationStatus updatedAt').lean();
    const resolve = await this.lineageResolver.forUser(userId, claims.flatMap(claim => claim.evidenceSources ?? []));

    for (const claim of claims) {
      const lineage = this.relationshipMapper.mapRelationships(resolve(claim.evidenceSources ?? []));
      const confidence = this.confidenceEngine.calculate(lineage, claim.verificationStatus);
      if (confidence === claim.confidence && isDeepStrictEqual(lineage, claim.lineage ?? [])) continue;

      // Persist edges and their derived score together. A concurrent claim edit triggers a rebuild.
      const update = await ResumeEvidenceClaim.updateOne(
        { _id: claim._id, userId, ...resumeClaimScope, updatedAt: claim.updatedAt ?? { $exists: false } },
        { $set: { lineage, confidence } },
        { runValidators: true },
      );
      if (!update.matchedCount && await ResumeEvidenceClaim.exists({ _id: claim._id, userId, ...resumeClaimScope })) {
        throw new Error('Evidence claim changed during graph rebuild');
      }
    }
  }

  /** Internal lookup for a claim already authorized by the caller. */
  async getTraceability(claimId: string) {
    const claim = await ResumeEvidenceClaim.findOne({ _id: claimId, ...resumeClaimScope })
      .select('+lineage evidenceSources confidence').lean();
    if (!claim) throw new Error('Claim not found');

    return {
      lineage: claim.lineage ?? [],
      provenance: claim.evidenceSources ?? [],
      confidence: claim.confidence,
    };
  }
}
