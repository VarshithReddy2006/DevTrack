import type { EvidenceEdge } from '../../../db/models/resumeEvidenceClaim.model.js';
import type { ResolvedEvidence } from './ClaimLineageResolver.js';

const relationships = {
  VerifiedProject: { relationship: 'verified_repository', weight: 90 },
  PlatformStats: { relationship: 'synced_platform_stats', weight: 70 },
  ResumeSession: { relationship: 'resume_origin', weight: 25 },
} as const;

export class EvidenceRelationshipMapper {
  mapRelationships(sources: ResolvedEvidence[]): EvidenceEdge[] {
    const edges = new Map<string, EvidenceEdge>();
    for (const source of sources) {
      edges.set(`${source.sourceModel}:${source.sourceId}`, {
        ...source,
        ...relationships[source.sourceModel],
      });
    }
    return [...edges.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, edge]) => edge);
  }
}
