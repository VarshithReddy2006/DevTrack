import React from 'react';
import { ExternalLink } from 'lucide-react';

interface Props {
  published: boolean;
  /** The live handle while published. */
  slug: string | null;
  canPublish: boolean;
  /** Published, and the handle in the field is not the live one. */
  handleChanged: boolean;
  busy: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
}

export const PublishBar: React.FC<Props> = ({ published, slug, canPublish, handleChanged, busy, onPublish, onUnpublish }) => (
  <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4">
    <p role="status" className="text-sm font-semibold text-slate-800">
      {published ? `Published at /u/${slug}` : 'Draft / Private'}
    </p>
    <div className="flex flex-wrap items-center gap-2">
      {published && slug && (
        <a
          href={`/u/${slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          View Live <ExternalLink size={12} aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
      {(!published || handleChanged) && (
        <button
          type="button"
          disabled={!canPublish || busy}
          onClick={onPublish}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {published ? 'Update handle' : 'Publish'}
        </button>
      )}
      {published && (
        <button
          type="button"
          disabled={busy}
          onClick={onUnpublish}
          className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Unpublish Immediately
        </button>
      )}
    </div>
  </div>
);
