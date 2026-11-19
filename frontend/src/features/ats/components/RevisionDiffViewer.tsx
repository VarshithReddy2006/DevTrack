import { useMemo, useState } from 'react';
import { diffArrays, diffWordsWithSpace } from 'diff';
import type { BulletEdit } from '@devtrack/ats-core';

type Row = { before?: string; after?: string };
const line = (bullet: BulletEdit) => `${bullet.section} / ${bullet.bulletIndex + 1}: ${bullet.editedText}`;
function changedRows(before: readonly BulletEdit[], after: readonly BulletEdit[]): Row[] {
  const rows: Row[] = []; let removed: string[] = [], added: string[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) rows.push({ before: removed[index], after: added[index] });
    removed = []; added = [];
  };
  for (const change of diffArrays(before.map(line), after.map(line))) {
    if (change.removed) removed.push(...change.value);
    else if (change.added) added.push(...change.value);
    else flush();
  }
  flush(); return rows;
}

export function RevisionDiffViewer({ before, after }: { before: readonly BulletEdit[]; after: readonly BulletEdit[] }) {
  const rows = useMemo(() => changedRows(before, after), [before, after]);
  const [requestedPage, setPage] = useState(0);
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(rows.length / 20) - 1));
  if (!rows.length) return <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">No bullet text changes in this comparison.</p>;
  return <section aria-label="Revision text differences" className="min-w-0 space-y-3">
    <p className="flex flex-wrap gap-3 text-xs"><span className="rounded bg-green-100 px-2 py-1 text-green-900">Added text</span><span className="rounded bg-red-100 px-2 py-1 text-red-900">Removed text</span></p>
    <ol className="space-y-3">{rows.slice(page * 20, page * 20 + 20).map((row, index) => {
      const changes = row.before !== undefined && row.after !== undefined
        ? diffWordsWithSpace(row.before, row.after)
        : [{ value: row.after ?? row.before ?? '', added: row.after !== undefined, removed: row.before !== undefined }];
      return <li key={page * 20 + index} className="whitespace-pre-wrap break-words rounded-lg border border-slate-200 p-3 text-sm leading-relaxed">
        {changes.map((part, partIndex) => part.added
          ? <ins key={partIndex} className="bg-green-100 text-green-900 no-underline">{part.value}</ins>
          : part.removed ? <del key={partIndex} className="bg-red-100 text-red-900">{part.value}</del> : <span key={partIndex}>{part.value}</span>)}
      </li>;
    })}</ol>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
      <span>Changes {page * 20 + 1}–{Math.min(rows.length, page * 20 + 20)} of {rows.length}</span>
      {rows.length > 20 && <div className="flex gap-2"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded border px-2 py-1 disabled:opacity-50">Previous changes</button><button type="button" disabled={(page + 1) * 20 >= rows.length} onClick={() => setPage(page + 1)} className="rounded border px-2 py-1 disabled:opacity-50">Next changes</button></div>}
    </div>
  </section>;
}
