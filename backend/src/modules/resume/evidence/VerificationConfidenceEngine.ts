import type { EvidenceEdge, VerificationStatus } from '../../../db/models/resumeEvidenceClaim.model.js';

export class VerificationConfidenceEngine {
  calculate(edges: EvidenceEdge[], status: VerificationStatus): number {
    if (status === 'flagged') return 0;
    // Repeated or correlated references contribute at most the strongest source weight.
    return edges.reduce((score, edge) => Math.max(score, edge.weight), 0);
  }
}
