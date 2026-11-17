import React from 'react';
import { ExternalLink } from 'lucide-react';
import type { EvidenceClaim } from '../../../services/evidenceService';
import { VerificationBadge } from './VerificationBadge';
import { SOURCE_LABELS, SUBJECT_TYPE_LABELS, claimSubjectType, safeSourceUrl } from '../utils/evidenceLedger';

const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

function formatDate(iso: string | undefined) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : { date, label: dateFormat.format(date) };
}

interface Props {
  claim: EvidenceClaim;
  now?: number;
}

export const EvidenceClaimRow: React.FC<Props> = ({ claim, now = Date.now() }) => {
  const sourceLabel = SOURCE_LABELS[claim.source] ?? claim.source;
  const href = safeSourceUrl(claim.sourceUrl);
  const checked = formatDate(claim.metadata?.lastVerifiedAt ?? claim.fetchedAt ?? claim.createdAt);
  const staleAfter = formatDate(claim.staleAfter);
  const isStale = !!staleAfter && staleAfter.date.getTime() < now;

  return (
    <tr className="border-t border-slate-200 align-top">
      <td className="px-4 py-3 text-sm text-slate-800">
        <p>{claim.claimText}</p>
        {claim.metadata?.flaggedReason && (
          <p className="mt-1 text-xs text-rose-700">Flag reason: {claim.metadata.flaggedReason}</p>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-slate-600">{SUBJECT_TYPE_LABELS[claimSubjectType(claim)]}</td>
      <td className="px-4 py-3 text-sm text-slate-600">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-indigo-700 underline underline-offset-2"
          >
            {sourceLabel}
            <ExternalLink size={12} aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          sourceLabel
        )}
      </td>
      <td className="px-4 py-3"><VerificationBadge status={claim.verificationStatus} /></td>
      <td className="px-4 py-3 text-sm text-slate-600 tabular-nums">{Math.round(claim.confidence)}%</td>
      <td className="px-4 py-3 text-sm text-slate-600">
        {checked ? <time dateTime={checked.date.toISOString()}>{checked.label}</time> : <span aria-label="No date recorded">-</span>}
        {isStale && <p className="text-xs text-amber-700">Stale, needs a fresh check</p>}
      </td>
    </tr>
  );
};
