import { CircleAlert } from 'lucide-react';

export function GapList({ gaps }: { gaps: { id: string; description: string }[] }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-labelledby="requirement-gaps">
      <h2 id="requirement-gaps" className="text-lg font-semibold">Requirement gaps</h2>
      {gaps.length ? (
        <ul className="mt-3 divide-y divide-slate-100">
          {gaps.map(gap => (
            <li key={gap.id} className="flex items-start gap-2 py-2 text-sm text-slate-700">
              <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-700" />
              {gap.description}
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-slate-600">No requirement gaps identified.</p>}
    </section>
  );
}
