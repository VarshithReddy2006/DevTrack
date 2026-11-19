import { createHash } from 'node:crypto';

export interface VerifiableClaim {
  _id: unknown;
  userId: unknown;
  claimText: string;
  source?: string;
  sourceUrl?: string;
  subjectType?: string;
  subjectKey?: string;
  verificationStatus?: string;
  metadata?: { flaggedReason?: string | null };
  proofVerification?: { state: string; reason: string };
  evidenceSources?: Array<{ type: string; referenceType: string; referenceId: string; metadata?: Record<string, unknown> }>;
}
export type EvidenceProof =
  | { kind: 'github_commit'; reference: string }
  | { kind: 'dsa_problem' | 'dsa_submission'; reference: string; platform: 'leetcode' | 'codeforces' }
  | { kind: 'invalid'; reason: string };

function canonical(value: unknown): unknown {
  if (value && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function') return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function evidenceInputHash(claim: VerifiableClaim): string {
  return sha256({ version: 1, userId: String(claim.userId), claimId: String(claim._id),
    claimText: claim.claimText, source: claim.source ?? 'user', sourceUrl: claim.sourceUrl,
    subjectType: claim.subjectType ?? 'resume_claim', subjectKey: claim.subjectKey,
    evidenceSources: (claim.evidenceSources ?? []).map(source => ({ type: source.type, referenceType: source.referenceType,
      referenceId: source.referenceId, metadata: source.metadata ?? {} })) });
}

/** Only explicit commit/problem/submission references are verifiable; never infer proofs from prose. */
export function evidenceProof(claim: VerifiableClaim): EvidenceProof | undefined {
  const proofs: EvidenceProof[] = [];
  if (claim.source === 'github' && claim.sourceUrl?.includes('/commit/')) proofs.push({ kind: 'github_commit', reference: claim.sourceUrl });
  for (const source of claim.evidenceSources ?? []) {
    if (source.type === 'github' && (source.referenceType === 'github_commit' || source.referenceId.includes('/commit/'))) {
      proofs.push({ kind: 'github_commit', reference: source.referenceId });
    } else if (source.type === 'dsa' && ['dsa_problem', 'dsa_submission'].includes(source.referenceType)) {
      const platform = source.metadata?.platform;
      if (!/^[a-f\d]{24}$/i.test(source.referenceId) || (platform !== 'leetcode' && platform !== 'codeforces')) {
        return { kind: 'invalid', reason: 'invalid_dsa_reference' };
      }
      proofs.push({ kind: source.referenceType as 'dsa_problem' | 'dsa_submission', reference: source.referenceId.toLowerCase(), platform });
    }
  }
  const unique = [...new Map(proofs.map(proof => [JSON.stringify(proof), proof])).values()];
  return unique.length > 1 ? { kind: 'invalid', reason: 'multiple_proof_references' } : unique[0];
}

export interface VerificationDecision {
  verified: boolean;
  reason: string;
  receipt: Record<string, unknown>;
}

/** Preserve flags imposed by other verification or moderation systems. */
export function hasExternalFlag(claim: VerifiableClaim): boolean {
  return claim.verificationStatus === 'flagged' && (claim.proofVerification?.state !== 'rejected'
    || claim.metadata?.flaggedReason !== claim.proofVerification.reason);
}
