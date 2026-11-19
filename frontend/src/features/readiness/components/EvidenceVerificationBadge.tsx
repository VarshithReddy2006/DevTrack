import React, { useState } from 'react';
import {
  AlertOctagon,
  CircleDot,
  Clock,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { EvidenceClaim, VerificationStatus } from '../../../services/evidenceService';
import { VerificationProofModal, type VerificationProof } from './VerificationProofModal';
import { VERIFICATION_STATUS_LABELS } from '../utils/evidenceLedger';

export type BadgeVerificationState = VerificationStatus | 'pending';

export interface EvidenceVerificationBadgeProps {
  status?: BadgeVerificationState;
  proof?: VerificationProof;
  claim?: EvidenceClaim;
  size?: 'sm' | 'md';
  showLabel?: boolean;
  className?: string;
  onOpenModal?: () => void;
  interactive?: boolean;
}

export function extractProofFromClaim(claim: EvidenceClaim): VerificationProof {
  const metadata = claim.metadata as Record<string, unknown> | undefined;
  const rawProof = metadata?.verificationProof as Record<string, unknown> | undefined;

  const authority = typeof rawProof?.authority === 'string'
    ? rawProof.authority
    : claim.source === 'github'
      ? 'GitHub Signature Attestation'
      : claim.source === 'leetcode'
        ? 'LeetCode Verified Submission'
        : claim.source === 'codeforces'
          ? 'Codeforces Verified Submission'
          : claim.source === 'devtrack_focus'
            ? 'DevTrack Focus Engine'
            : 'DevTrack Cryptographic Notary';

  const hash = typeof rawProof?.hash === 'string'
    ? rawProof.hash
    : typeof rawProof?.commitSha === 'string'
      ? rawProof.commitSha
      : undefined;

  const verifiedAt = typeof rawProof?.verifiedAt === 'string'
    ? rawProof.verifiedAt
    : (claim.metadata?.lastVerifiedAt ?? claim.fetchedAt ?? claim.createdAt);

  const signatureStatus = typeof rawProof?.signatureStatus === 'string'
    ? (rawProof.signatureStatus as VerificationProof['signatureStatus'])
    : undefined;

  return {
    status: claim.verificationStatus,
    hash,
    platform: (rawProof?.platform as string) ?? claim.source,
    sourceUrl: (rawProof?.sourceUrl as string) ?? claim.sourceUrl,
    verifiedAt,
    authority,
    signatureStatus,
    commitSha: typeof rawProof?.commitSha === 'string' ? rawProof.commitSha : undefined,
    claimText: claim.claimText,
    confidence: claim.confidence,
    flaggedReason: claim.metadata?.flaggedReason ?? undefined,
  };
}

const BADGE_CONFIG: Record<
  BadgeVerificationState,
  {
    label: string;
    Icon: React.ElementType;
    containerClass: string;
    interactiveClass: string;
  }
> = {
  verified: {
    label: 'Verified',
    Icon: ShieldCheck,
    containerClass: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
    interactiveClass: 'cursor-pointer hover:bg-emerald-100 hover:border-emerald-300 active:bg-emerald-200/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-1',
  },
  pending: {
    label: 'Pending',
    Icon: Clock,
    containerClass: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
    interactiveClass: '',
  },
  unverified: {
    label: 'Unverified',
    Icon: ShieldAlert,
    containerClass: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
    interactiveClass: '',
  },
  partial: {
    label: 'Partially verified',
    Icon: CircleDot,
    containerClass: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
    interactiveClass: '',
  },
  flagged: {
    label: 'Flagged',
    Icon: AlertOctagon,
    containerClass: 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800',
    interactiveClass: '',
  },
};

export const EvidenceVerificationBadge: React.FC<EvidenceVerificationBadgeProps> = ({
  status: statusProp,
  proof: proofProp,
  claim,
  size = 'md',
  showLabel = true,
  className = '',
  onOpenModal,
  interactive = true,
}) => {
  const [internalModalOpen, setInternalModalOpen] = useState(false);

  // Derive resolved proof and status
  const resolvedProof: VerificationProof | undefined = proofProp ?? (claim ? extractProofFromClaim(claim) : undefined);
  const resolvedStatus: BadgeVerificationState =
    statusProp ??
    resolvedProof?.status ??
    claim?.verificationStatus ??
    'unverified';

  const config = BADGE_CONFIG[resolvedStatus] ?? BADGE_CONFIG.unverified;
  const label = config.label || (VERIFICATION_STATUS_LABELS[resolvedStatus as VerificationStatus] ?? 'Unverified');
  const Icon = config.Icon;

  const isVerified = resolvedStatus === 'verified';
  const isClickable = interactive && isVerified;

  const handleClick = (e: React.MouseEvent) => {
    if (!isClickable) return;
    e.stopPropagation();
    if (onOpenModal) {
      onOpenModal();
    } else {
      setInternalModalOpen(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isClickable) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (onOpenModal) {
        onOpenModal();
      } else {
        setInternalModalOpen(true);
      }
    }
  };

  const sizeClasses = size === 'sm'
    ? 'gap-1 px-2 py-0.5 text-[11px]'
    : 'gap-1.5 px-2.5 py-1 text-xs';
  const iconSize = size === 'sm' ? 12 : 14;

  const badgeContent = (
    <>
      <Icon size={iconSize} aria-hidden="true" className="shrink-0" />
      {showLabel && <span className="truncate">{label}</span>}
      {isClickable && (
        <span className="sr-only">. Click to view cryptographic verification details.</span>
      )}
    </>
  );

  return (
    <>
      {isClickable ? (
        <button
          type="button"
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          aria-haspopup="dialog"
          aria-expanded={internalModalOpen}
          aria-label={`Verified claim: ${label}. Click to view cryptographic proof.`}
          data-status={resolvedStatus}
          data-testid="evidence-verification-badge-button"
          className={`inline-flex items-center font-semibold rounded-full border transition-all duration-150 ${sizeClasses} ${config.containerClass} ${config.interactiveClass} ${className}`}
        >
          {badgeContent}
        </button>
      ) : (
        <span
          data-status={resolvedStatus}
          data-testid="evidence-verification-badge-static"
          aria-label={`${label} evidence`}
          className={`inline-flex items-center font-semibold rounded-full border ${sizeClasses} ${config.containerClass} ${className}`}
        >
          {badgeContent}
        </span>
      )}

      {/* Internal Modal when not externally controlled */}
      {!onOpenModal && resolvedProof && (
        <VerificationProofModal
          open={internalModalOpen}
          onClose={() => setInternalModalOpen(false)}
          proof={resolvedProof}
          claimTitle={claim?.claimText}
        />
      )}
    </>
  );
};
