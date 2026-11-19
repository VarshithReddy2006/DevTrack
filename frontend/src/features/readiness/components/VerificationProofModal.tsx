import React, { useState, useEffect, useRef } from 'react';
import {
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  AlertOctagon,
  FileCheck2,
} from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { safeSourceUrl, SOURCE_LABELS, VERIFICATION_STATUS_LABELS } from '../utils/evidenceLedger';
import type { VerificationStatus } from '../../../services/evidenceService';

export interface VerificationProof {
  status: VerificationStatus | 'pending';
  hash?: string;
  platform?: string;
  sourceUrl?: string;
  verifiedAt?: string | Date;
  authority?: string;
  signatureStatus?: 'gpg_verified' | 'platform_attested' | 'unverified' | 'none';
  commitSha?: string;
  claimText?: string;
  confidence?: number;
  flaggedReason?: string;
}

export interface VerificationProofModalProps {
  open: boolean;
  onClose: () => void;
  proof: VerificationProof;
  claimTitle?: string;
}

const proofDateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const PLATFORM_DOMAINS: Record<string, string[]> = {
  github: ['github.com', 'gist.github.com'],
  leetcode: ['leetcode.com'],
  codeforces: ['codeforces.com'],
};

export function resolvePlatformDestination(
  rawUrl: string | undefined,
  platform?: string
): { href: string | null; label: string; isPlatformMatch: boolean } {
  const href = safeSourceUrl(rawUrl);
  if (!href) {
    return { href: null, label: 'No external link available', isPlatformMatch: false };
  }

  try {
    const parsed = new URL(href);
    const hostname = parsed.hostname.toLowerCase();

    const platformKey = platform?.toLowerCase();
    const allowedDomains = platformKey ? PLATFORM_DOMAINS[platformKey] : undefined;

    const isMatch = allowedDomains
      ? allowedDomains.some((domain) => hostname === domain || hostname.endsWith('.' + domain))
      : false;

    if (isMatch && platformKey) {
      const platformName = SOURCE_LABELS[platformKey] ?? platformKey;
      return { href, label: `Verify on ${platformName}`, isPlatformMatch: true };
    }

    // Mismatched or generic destination: display actual hostname to prevent domain spoofing
    return { href, label: `Open on ${hostname}`, isPlatformMatch: false };
  } catch {
    return { href: null, label: 'No external link available', isPlatformMatch: false };
  }
}

function formatProofDate(dateInput: string | Date | undefined) {
  if (!dateInput) return null;
  const date = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (Number.isNaN(date.getTime())) return null;
  return { date, label: proofDateFormat.format(date) };
}

export const VerificationProofModal: React.FC<VerificationProofModalProps> = ({
  open,
  onClose,
  proof,
  claimTitle,
}) => {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // UX-01: Reset clipboard feedback immediately when modal closes or unmounts
  useEffect(() => {
    if (!open) {
      setCopied(false);
      setCopyError(false);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const rawHash = proof.hash || proof.commitSha;
  const destination = resolvePlatformDestination(proof.sourceUrl, proof.platform);
  const formattedDate = formatProofDate(proof.verifiedAt);
  const authorityLabel = proof.authority || (
    proof.platform === 'github'
      ? 'GitHub Signature Attestation'
      : proof.platform === 'leetcode'
        ? 'LeetCode Verified Submission'
        : 'DevTrack Cryptographic Notary'
  );

  const handleCopyHash = async () => {
    if (!rawHash) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(rawHash);
        setCopied(true);
        setCopyError(false);
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch {
      setCopyError(true);
      setCopied(false);
    }

    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
      setCopyError(false);
    }, 2000);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cryptographic Evidence Proof"
      description="Cryptographic proof details and attestation for this verified evidence claim."
      size="md"
    >
      <div className="flex flex-col gap-4 text-sm text-slate-700" data-testid="verification-proof-modal-content">
        {/* Verification Status & Authority Header */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50/75 p-3.5">
          <div className="flex items-center gap-2.5">
            {proof.status === 'verified' && (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                <ShieldCheck size={18} aria-hidden="true" />
              </span>
            )}
            {proof.status === 'pending' && (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                <Clock size={18} aria-hidden="true" />
              </span>
            )}
            {proof.status === 'unverified' && (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-200 text-slate-600">
                <ShieldAlert size={18} aria-hidden="true" />
              </span>
            )}
            {proof.status === 'flagged' && (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-100 text-rose-700">
                <AlertOctagon size={18} aria-hidden="true" />
              </span>
            )}
            {proof.status === 'partial' && (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                <FileCheck2 size={18} aria-hidden="true" />
              </span>
            )}
            <div>
              <p className="font-semibold text-slate-900" data-testid="proof-status-label">
                {proof.status === 'pending'
                  ? 'Verification in progress'
                  : (VERIFICATION_STATUS_LABELS[proof.status as VerificationStatus] ?? 'Verified')}
              </p>
              <p className="text-xs text-slate-500" data-testid="proof-authority-label">
                Attested by {authorityLabel}
              </p>
            </div>
          </div>

          {proof.signatureStatus === 'gpg_verified' && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800"
              data-testid="proof-signature-badge"
            >
              <CheckCircle2 size={12} aria-hidden="true" /> GPG Verified
            </span>
          )}
          {proof.signatureStatus === 'platform_attested' && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-800"
              data-testid="proof-signature-badge"
            >
              <FileCheck2 size={12} aria-hidden="true" /> Platform Attested
            </span>
          )}
        </div>

        {/* Claim context if provided */}
        {(claimTitle || proof.claimText) && (
          <div className="rounded-xl border border-slate-200 p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Subject Claim</span>
            <p className="mt-1 text-sm font-medium text-slate-800">
              {claimTitle || proof.claimText}
            </p>
            {proof.confidence !== undefined && (
              <p className="mt-1 text-xs text-slate-500">
                Confidence rating: <span className="font-semibold text-slate-700">{Math.round(proof.confidence)}%</span>
              </p>
            )}
            {proof.flaggedReason && (
              <p className="mt-1 text-xs text-rose-700">
                Flag reason: {proof.flaggedReason}
              </p>
            )}
          </div>
        )}

        {/* Cryptographic SHA-256 Digest Section */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700">
              <KeyRound size={13} aria-hidden="true" /> Cryptographic Proof Hash (SHA-256)
            </span>
            {rawHash && (
              <span className="text-[10px] text-slate-400 font-mono">
                {rawHash.length}-character digest
              </span>
            )}
          </div>

          {rawHash ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <code
                  className="font-mono text-xs text-slate-800 break-all select-all leading-relaxed"
                  data-testid="proof-hash"
                  title={rawHash}
                >
                  {rawHash}
                </code>
                <button
                  type="button"
                  onClick={() => void handleCopyHash()}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  aria-label="Copy SHA-256 cryptographic hash to clipboard"
                  data-testid="copy-hash-button"
                >
                  {copied ? (
                    <>
                      <Check size={13} className="text-emerald-600" aria-hidden="true" />
                      <span className="text-emerald-700 font-medium">Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy size={13} aria-hidden="true" />
                      <span>Copy Hash</span>
                    </>
                  )}
                </button>
              </div>

              {/* Accessible Live Region Announcements */}
              <div aria-live="polite" aria-atomic="true" className="sr-only" role="status">
                {copied && 'Cryptographic hash copied to clipboard successfully.'}
                {copyError && 'Failed to copy hash to clipboard.'}
              </div>

              {copyError && (
                <p role="alert" className="text-xs text-rose-600">
                  Unable to access clipboard. Please copy the hash manually.
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 p-3 text-xs text-slate-500">
              No cryptographic digest recorded for this claim.
            </div>
          )}
        </div>

        {/* Verification Timestamp and Platform Deep Link */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1 border-t border-slate-100">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Verification Timestamp</span>
            <p className="mt-0.5 text-xs text-slate-800 font-medium">
              {formattedDate ? (
                <time dateTime={formattedDate.date.toISOString()} data-testid="proof-timestamp">
                  {formattedDate.label}
                </time>
              ) : (
                <span className="text-slate-400">No timestamp recorded</span>
              )}
            </p>
          </div>

          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Platform Reference</span>
            <div className="mt-1">
              {destination.href ? (
                <a
                  href={destination.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    destination.isPlatformMatch
                      ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                      : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
                  }`}
                  data-testid="platform-proof-link"
                >
                  <span>{destination.label}</span>
                  <ExternalLink size={12} aria-hidden="true" />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : (
                <span className="text-xs text-slate-500 italic">No external link available</span>
              )}
            </div>
          </div>
        </div>

        {/* Modal Footer Close Action */}
        <div className="mt-2 flex justify-end border-t border-slate-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            data-testid="modal-close-button"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
};
