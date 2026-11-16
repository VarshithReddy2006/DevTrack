import type { FilterQuery, Types } from 'mongoose';
import {
  ResumeEvidenceClaim,
  resumeClaimScope,
  type EvidenceSource,
  type EvidenceSubjectType,
  type IEvidenceSource,
  type IResumeEvidenceClaim,
  type ProvenanceType,
  type VerificationStatus,
} from '../../../db/models/resumeEvidenceClaim.model.js';
import { ResumeProfile } from '../../../db/models/resumeProfile.model.js';
import { EVIDENCE_LEDGER_INDEX } from '../../../db/models/evidenceLedgerIndex.js';

interface ClaimFilters {
  subjectType?: EvidenceSubjectType;
  verificationStatus?: VerificationStatus;
}

type ClaimSubject =
  | { subjectType: 'resume_claim'; resumeProfileId: Types.ObjectId }
  | { subjectType: Exclude<EvidenceSubjectType, 'resume_claim'>; resumeProfileId?: never };

export type EvidenceClaimInput = ClaimSubject & {
  subjectKey: string;
  claimText: string;
  source: EvidenceSource;
  sourceUrl?: string;
  fetchedAt: Date;
  staleAfter?: Date;
  verificationStatus?: VerificationStatus;
  evidenceSources?: IEvidenceSource[];
  provenance?: ProvenanceType[];
  confidence?: number;
};

export async function listEvidenceClaims(userId: string, filters: ClaimFilters) {
  const query: FilterQuery<IResumeEvidenceClaim> = { userId };
  if (filters.subjectType === 'resume_claim') Object.assign(query, resumeClaimScope);
  else if (filters.subjectType) query.subjectType = filters.subjectType;
  if (filters.verificationStatus) query.verificationStatus = filters.verificationStatus;
  return ResumeEvidenceClaim.find(query).sort({ createdAt: -1, _id: -1 });
}

export async function upsertClaim(userId: Types.ObjectId, input: EvidenceClaimInput) {
  const subjectKey = input.subjectKey.trim();
  if (!subjectKey || subjectKey.startsWith('legacy:')) throw new Error('Invalid evidence subject key');
  if (!(input.fetchedAt instanceof Date) || !Number.isFinite(input.fetchedAt.getTime())) {
    throw new Error('Evidence requires a valid fetch date');
  }
  if (input.subjectType === 'resume_claim' &&
      (!input.resumeProfileId || !await ResumeProfile.exists({ _id: input.resumeProfileId, userId }))) {
    throw new Error('Resume evidence requires an owned resume profile');
  }

  await ResumeEvidenceClaim.init();

  const key = { userId, subjectType: input.subjectType, subjectKey };
  const update = {
    $setOnInsert: key,
    $set: {
      resumeProfileId: input.subjectType === 'resume_claim' ? input.resumeProfileId : undefined,
      claimText: input.claimText,
      source: input.source,
      sourceUrl: input.sourceUrl,
      fetchedAt: input.fetchedAt,
      staleAfter: input.staleAfter,
      verificationStatus: input.verificationStatus,
      evidenceSources: input.evidenceSources,
      provenance: input.provenance,
      confidence: input.confidence,
    },
  };
  const options = { new: true, runValidators: true, upsert: true } as const;

  try {
    return await ResumeEvidenceClaim.findOneAndUpdate(key, update, options).orFail();
  } catch (error) {
    const duplicate = error as { code?: number; keyPattern?: Record<string, number> };
    if (duplicate.code !== 11000 ||
        !Object.keys(EVIDENCE_LEDGER_INDEX.key).every(field => duplicate.keyPattern?.[field] === 1)) throw error;
    // A concurrent upsert inserted the same subject. Update the winning row.
    return ResumeEvidenceClaim.findOneAndUpdate(key, update, { ...options, upsert: false }).orFail();
  }
}
