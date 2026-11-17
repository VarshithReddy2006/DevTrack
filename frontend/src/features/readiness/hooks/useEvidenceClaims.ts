import { useQuery } from '@tanstack/react-query';
import { fetchEvidenceClaims, type EvidenceClaim, type EvidenceClaimFilters } from '../../../services/evidenceService';

export function useEvidenceClaims(filters: EvidenceClaimFilters) {
  return useQuery<EvidenceClaim[], Error>({
    queryKey: ['evidenceClaims', filters.subjectType ?? null, filters.verificationStatus ?? null],
    queryFn: ({ signal }) => fetchEvidenceClaims(filters, { signal }),
    staleTime: 60 * 1000,
    retry: 1,
  });
}
