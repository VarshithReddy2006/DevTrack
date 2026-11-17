import type { EvidenceClaim, EvidenceSubjectType, VerificationStatus } from '../../../services/evidenceService';

export const SUBJECT_TYPE_LABELS: Record<EvidenceSubjectType, string> = {
  resume_claim: 'Resume claim',
  repo: 'Repository',
  dsa_rating: 'DSA rating',
  focus_consistency: 'Focus consistency',
  certification: 'Certification',
};

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  verified: 'Verified',
  partial: 'Partially verified',
  unverified: 'Unverified',
  flagged: 'Flagged',
};

export const SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub',
  leetcode: 'LeetCode',
  codeforces: 'Codeforces',
  devtrack_focus: 'DevTrack focus sessions',
  user: 'Added by you',
};

/** The backend treats a missing subject type as a legacy resume claim. */
export function claimSubjectType(claim: Pick<EvidenceClaim, 'subjectType'>): EvidenceSubjectType {
  return claim.subjectType ?? 'resume_claim';
}

/** Only http(s) links are rendered as anchors. */
export function safeSourceUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Every whitespace separated term must appear in the claim text, key, source or subject label. */
export function filterClaimsBySearch(claims: EvidenceClaim[], search: string): EvidenceClaim[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return claims;
  return claims.filter((claim) => {
    const haystack = [
      claim.claimText,
      claim.subjectKey,
      SOURCE_LABELS[claim.source] ?? claim.source,
      claim.sourceUrl,
      SUBJECT_TYPE_LABELS[claimSubjectType(claim)],
    ].join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
