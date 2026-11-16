// ============================================================================
// evidenceService.ts - Evidence Ledger API Service
// ============================================================================
// HTTP-only. Lists the signed-in user's evidence claims.
// ============================================================================

import axiosClient from '../utils/axiosClient';
import type { ApiResponse } from '../types/api.types';

// Mirrors backend/src/db/models/resumeEvidenceClaim.model.ts
export const EVIDENCE_SUBJECT_TYPES = ['resume_claim', 'repo', 'dsa_rating', 'focus_consistency', 'certification'] as const;
export const VERIFICATION_STATUSES = ['verified', 'partial', 'unverified', 'flagged'] as const;

export type EvidenceSubjectType = typeof EVIDENCE_SUBJECT_TYPES[number];
export type VerificationStatus = typeof VERIFICATION_STATUSES[number];
export type EvidenceSource = 'github' | 'leetcode' | 'codeforces' | 'devtrack_focus' | 'user';

export interface EvidenceClaim {
  id: string;
  /** Claims written by legacy versions have no subject type; treat them as resume claims. */
  subjectType?: EvidenceSubjectType | null;
  subjectKey?: string;
  source: EvidenceSource;
  sourceUrl?: string;
  fetchedAt?: string;
  staleAfter?: string;
  claimText: string;
  verificationStatus: VerificationStatus;
  /** 0-100 */
  confidence: number;
  metadata?: {
    lastVerifiedAt: string | null;
    verificationAttempts: number;
    flaggedReason: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceClaimFilters {
  subjectType?: EvidenceSubjectType;
  verificationStatus?: VerificationStatus;
}

export async function fetchEvidenceClaims(
  filters: EvidenceClaimFilters = {},
  options?: { signal?: AbortSignal },
): Promise<EvidenceClaim[]> {
  const params: EvidenceClaimFilters = {};
  if (filters.subjectType) params.subjectType = filters.subjectType;
  if (filters.verificationStatus) params.verificationStatus = filters.verificationStatus;
  const { data } = await axiosClient.get<ApiResponse<EvidenceClaim[]>>('/evidence/claims', {
    params,
    signal: options?.signal,
  });
  return data.data;
}
