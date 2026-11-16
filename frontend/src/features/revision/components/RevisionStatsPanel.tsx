interface RevisionStatsPanelProps {
  dueCount: number;
  completedCount: number;
  streak: number | null;
}

export function RevisionStatsPanel({ dueCount, completedCount, streak }: RevisionStatsPanelProps) {
  return (
    <section className="grid gap-3 sm:grid-cols-3" aria-label="Revision statistics">
      <div className="dt-card p-4"><p className="text-xs uppercase tracking-wide text-dt-textSecondary">In this deck</p><p className="mt-2 text-2xl font-bold text-dt-text">{dueCount}</p></div>
      <div className="dt-card p-4"><p className="text-xs uppercase tracking-wide text-dt-textSecondary">Reviewed now</p><p className="mt-2 text-2xl font-bold text-dt-text">{completedCount}</p></div>
      <div className="dt-card p-4"><p className="text-xs uppercase tracking-wide text-dt-textSecondary">Activity streak</p><p className="mt-2 text-2xl font-bold text-dt-text">{streak === null ? '—' : `${streak} days`}</p></div>
      <p className="sm:col-span-3 text-xs text-dt-textSecondary">A memory retention curve needs review history. The current revision API does not provide it yet.</p>
    </section>
  );
}
