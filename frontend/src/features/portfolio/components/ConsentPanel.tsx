import React from 'react';

/** Bump when the consent copy below changes; it is stored with the publication. */
export const CONSENT_VERSION = '2026-11';

interface Props {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Already published: the consent on record is shown instead of asking again. */
  acceptedVersion?: string | null;
  publishedAt?: string | null;
}

export const ConsentPanel: React.FC<Props> = ({ checked, onChange, acceptedVersion, publishedAt }) => {
  const accepted = !!acceptedVersion;
  return (
    <section aria-labelledby="portfolio-consent-title" className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h2 id="portfolio-consent-title" className="text-sm font-semibold text-slate-800">Before you publish</h2>
      <ul className="list-disc space-y-1 pl-5 text-xs text-slate-600">
        <li>Your page is private until you publish it. Nothing is shared by default.</li>
        <li>Anyone with the link can see the sections you switch on, without signing in.</li>
        <li>You can unpublish at any time. The page stops loading on the next request.</li>
        <li>Your handle becomes part of the public URL.</li>
      </ul>
      {accepted ? (
        <p className="text-xs text-slate-600">
          You accepted this on {publishedAt ? new Date(publishedAt).toLocaleDateString('en', { dateStyle: 'medium' }) : 'an earlier publish'} (version {acceptedVersion}).
        </p>
      ) : (
        <label className="flex items-start gap-2 text-sm text-slate-800">
          <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-4 w-4" />
          <span>I understand and I want to make the selected sections public.</span>
        </label>
      )}
    </section>
  );
};
