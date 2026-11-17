import React from 'react';
import { AlertOctagon, CheckCircle2, CircleDashed, CircleDot } from 'lucide-react';
import type { VerificationStatus } from '../../../services/evidenceService';
import { VERIFICATION_STATUS_LABELS } from '../utils/evidenceLedger';

const STYLES: Record<VerificationStatus, { className: string; Icon: React.ElementType }> = {
  verified: { className: 'bg-emerald-50 text-emerald-800 border-emerald-200', Icon: CheckCircle2 },
  partial: { className: 'bg-amber-50 text-amber-800 border-amber-200', Icon: CircleDot },
  unverified: { className: 'bg-slate-100 text-slate-700 border-slate-300', Icon: CircleDashed },
  flagged: { className: 'bg-rose-50 text-rose-800 border-rose-200', Icon: AlertOctagon },
};

interface Props {
  status: VerificationStatus;
}

/** Colour is never the only signal: the status is always written out as text. */
export const VerificationBadge: React.FC<Props> = ({ status }) => {
  const style = STYLES[status] ?? STYLES.unverified;
  const label = VERIFICATION_STATUS_LABELS[status] ?? VERIFICATION_STATUS_LABELS.unverified;
  return (
    <span
      data-status={STYLES[status] ? status : 'unverified'}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${style.className}`}
    >
      <style.Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
};
