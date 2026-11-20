import type { RevisionPatternStat } from '../../../services/revisionService';
import { retentionLabel, retentionLevel, retentionLevels, topicLabel, type RetentionLevel } from '../topics';

interface RetentionHeatmapProps {
  patterns: RevisionPatternStat[];
  selected: string | null;
  onSelect: (topic: string | null) => void;
}

const levelClasses: Record<RetentionLevel, string> = {
  critical: 'border-red-300 bg-red-100 text-red-900',
  'at-risk': 'border-orange-300 bg-orange-100 text-orange-900',
  steady: 'border-lime-300 bg-lime-100 text-lime-900',
  mastered: 'border-emerald-300 bg-emerald-100 text-emerald-900',
};

export function RetentionHeatmap({ patterns, selected, onSelect }: RetentionHeatmapProps) {
  // Weakest topics first, so the cells that need attention lead the grid.
  const cells = [...patterns].sort((a, b) => a.retentionPercentage - b.retentionPercentage || a.pattern.localeCompare(b.pattern));

  return (
    <section className="dt-card p-4" aria-labelledby="retention-heatmap-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="retention-heatmap-title" className="text-sm font-semibold text-dt-text">Retention by topic</h2>
        <ul className="flex flex-wrap gap-3 text-xs text-dt-textSecondary" aria-label="Retention legend">
          {[...retentionLevels].reverse().map(({ level, label, min }) => (
            <li key={level} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`h-3 w-3 rounded-sm border ${levelClasses[level]}`} />
              {label} {level === 'critical' ? '(<50%)' : `(${min}%+)`}
            </li>
          ))}
        </ul>
      </div>
      {cells.length === 0 ? (
        <p className="mt-4 text-sm text-dt-textSecondary">Topic retention appears after your first revision cards are created.</p>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {cells.map((cell) => {
            const level = retentionLevel(cell.retentionPercentage);
            const percent = Math.round(cell.retentionPercentage);
            const isSelected = selected === cell.pattern;
            return (
              <li key={cell.pattern}>
                <button
                  type="button"
                  data-level={level}
                  aria-pressed={isSelected}
                  aria-label={`${topicLabel(cell.pattern)}: ${percent}% retention, ${retentionLabel(level)}, ${cell.totalCards} card${cell.totalCards === 1 ? '' : 's'}`}
                  onClick={() => onSelect(isSelected ? null : cell.pattern)}
                  className={`flex h-full w-full flex-col items-start rounded-xl border p-3 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dt-primary ${levelClasses[level]} ${isSelected ? 'ring-2 ring-dt-primary' : ''}`}
                >
                  <span className="w-full truncate text-sm font-semibold">{topicLabel(cell.pattern)}</span>
                  <span className="mt-1 text-xl font-bold">{percent}%</span>
                  <span className="text-xs opacity-80">{cell.totalCards} card{cell.totalCards === 1 ? '' : 's'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
