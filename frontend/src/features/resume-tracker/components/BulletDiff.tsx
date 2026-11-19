import { useMemo } from 'react';
import { diffWordsWithSpace } from 'diff';

export default function BulletDiff({ original, current }: { original: string; current: string }) {
  const changes = useMemo(() => diffWordsWithSpace(original, current, { timeout: 50, maxEditLength: 2_000 }), [original, current]);
  return <section aria-labelledby="bullet-diff-heading" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
    <h2 id="bullet-diff-heading" className="font-semibold">Compare changes</h2>
    {!changes && <p className="text-sm text-slate-600">Large edit: showing both complete versions.</p>}
    <div className="grid min-w-0 gap-4 md:grid-cols-2">
      <div className="min-w-0"><h3 className="mb-2 text-sm font-medium">Saved version</h3><pre className="whitespace-pre-wrap break-words text-sm">{changes ? changes.filter(change => !change.added).map((change, i) => change.removed ? <del key={i} className="bg-red-100 text-red-900">{change.value}</del> : change.value) : original}</pre></div>
      <div className="min-w-0"><h3 className="mb-2 text-sm font-medium">Edited version</h3><pre className="whitespace-pre-wrap break-words text-sm">{changes ? changes.filter(change => !change.removed).map((change, i) => change.added ? <ins key={i} className="bg-green-100 text-green-900">{change.value}</ins> : change.value) : current}</pre></div>
    </div>
  </section>;
}
