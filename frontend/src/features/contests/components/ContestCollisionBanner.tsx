import { TriangleAlert } from 'lucide-react';
import type { ContestCollisions } from '../contestCalendar';

export function ContestCollisionBanner({ collisions }: { collisions: ContestCollisions }) {
  if (collisions.count === 0) return null;
  return (
    <section aria-label="Overlapping contests" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
      <p role="status" className="flex items-center gap-2 font-semibold">
        <TriangleAlert size={17} aria-hidden="true" />
        {collisions.count} overlapping contest {collisions.count === 1 ? 'pair' : 'pairs'} in this view
      </p>
      <p className="mt-1 text-xs">These contests share some scheduled time. Check the details before choosing which to join.</p>
      <ul className="mt-2 list-inside list-disc space-y-1 text-xs">
        {collisions.preview.map(([a, b]) => <li key={`${a.key}|${b.key}`}>{a.contest.contestName} / {b.contest.contestName}</li>)}
      </ul>
      {collisions.count > collisions.preview.length && <p className="mt-2 text-xs">Showing the first {collisions.preview.length} pairs. All affected events are marked on the calendar.</p>}
    </section>
  );
}
