// ============================================================================
// ProjectBoardView.tsx — Full-page kanban board for projects by status
// ============================================================================
// Shows projects grouped by status columns (Planning, In Progress, Review, Completed).
// Each project appears as a compact card in its status column.
// ============================================================================

import React from 'react';
import { motion } from 'framer-motion';
import { Icon, type IconName } from '../../../components/shared/Icon';
import type { ProjectCardVM } from '../../../types/vm.types';

interface ProjectBoardViewProps {
  projects: ProjectCardVM[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  deletingId: string | null;
}

const BOARD_COLUMNS: { key: string; label: string; color: string; bgColor: string; borderColor: string; icon: IconName }[] = [
  { key: 'planning', label: 'Planning', color: 'text-indigo-600', bgColor: 'bg-indigo-50', borderColor: 'border-indigo-200', icon: 'pencil-square' },
  { key: 'in_progress', label: 'In Progress', color: 'text-blue-600', bgColor: 'bg-blue-50', borderColor: 'border-blue-200', icon: 'clock' },
  { key: 'review', label: 'Review', color: 'text-amber-600', bgColor: 'bg-amber-50', borderColor: 'border-amber-200', icon: 'eye' },
  { key: 'completed', label: 'Completed', color: 'text-emerald-600', bgColor: 'bg-emerald-50', borderColor: 'border-emerald-200', icon: 'check-circle' },
];

function progressPercent(card: ProjectCardVM): number {
  if (card.status === 'completed') return 100;
  if (card.milestonesProgress) return card.milestonesProgress.percent;
  if (card.status === 'planning') return 10;
  if (card.status === 'in_progress') return 50;
  return 0;
}

export const ProjectBoardView: React.FC<ProjectBoardViewProps> = ({
  projects,
  onOpen,
  onDelete: _onDelete,
  deletingId,
}) => {
  const grouped = React.useMemo(() => {
    const groups: Record<string, ProjectCardVM[]> = {};
    for (const col of BOARD_COLUMNS) groups[col.key] = [];
    for (const p of projects) {
      const key = p.status || 'planning';
      if (groups[key]) {
        groups[key].push(p);
      } else {
        groups.planning.push(p);
      }
    }
    return groups;
  }, [projects]);

  return (
    <div className="flex overflow-x-auto md:grid md:grid-cols-2 xl:grid-cols-4 gap-6 pb-16 scrollbar-none snap-x snap-mandatory [-webkit-overflow-scrolling:touch] -mx-4 px-4 md:mx-0 md:px-0">
      {BOARD_COLUMNS.map((col) => (
        <div key={col.key} className="flex flex-col min-w-[290px] sm:min-w-[330px] md:min-w-0 snap-align-start shrink-0">
          {/* Column header */}
          <div className="flex items-center gap-2 mb-3 bg-white/45 backdrop-blur-md md:bg-transparent py-2 px-3.5 md:p-0 rounded-2xl border border-gray-150/40 md:border-none">
            <div className={`w-6 h-6 rounded-lg ${col.bgColor} flex items-center justify-center`}>
              <Icon name={col.icon} size={13} className={col.color} />
            </div>
            <span className="text-[12px] font-bold text-dt-text uppercase tracking-wider">{col.label}</span>
            <span className="text-[12px] font-medium text-dt-textMuted ml-auto tabular-nums">
              {grouped[col.key].length}
            </span>
          </div>

          {/* Project cards */}
          <div className={`flex flex-col gap-2.5 min-h-[120px] p-2 rounded-xl bg-gray-50/50 border border-dashed ${col.borderColor}/40`}>
            {grouped[col.key].length === 0 && (
              <div className="flex items-center justify-center py-8 text-[11px] text-dt-textMuted/50 font-medium">
                No projects
              </div>
            )}
            {grouped[col.key].map((p, i) => {
              const progress = progressPercent(p);
              const isDeleting = deletingId === p.id;

              return (
                <motion.button
                  key={p.id}
                  type="button"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: isDeleting ? 0.3 : 1, y: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.05 }}
                  onClick={() => onOpen(p.id)}
                  className={[
                    'bg-white border border-gray-200 rounded-xl p-3.5 cursor-pointer text-left w-full focus-visible:outline-2 focus-visible:outline-dt-primary',
                    'hover:border-dt-primary/20 hover:shadow-sm transition-all duration-200',
                    isDeleting ? 'pointer-events-none' : '',
                  ].join(' ')}
                >
                  {/* Name + status */}
                  <h4 className="text-[13.5px] font-semibold text-dt-text truncate mb-1.5">{p.name}</h4>

                  {/* Description */}
                  {p.description && (
                    <p className="text-[11px] text-dt-textMuted line-clamp-2 leading-relaxed mb-2.5">{p.description}</p>
                  )}

                  {/* Progress bar */}
                  <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden mb-2">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        col.key === 'completed' ? 'bg-emerald-500' : 'bg-dt-primary'
                      }`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>

                  {/* Footer: tech + updated */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      {p.techStack.slice(0, 2).map(t => (
                        <span key={t} className="text-[9px] font-medium text-dt-textMuted bg-gray-50 px-1.5 py-0.5 rounded">{t}</span>
                      ))}
                      {p.techStack.length > 2 && (
                        <span className="text-[9px] text-dt-textMuted">+{p.techStack.length - 2}</span>
                      )}
                    </div>
                    <span className="text-[10px] text-dt-textMuted/60 font-medium">{p.updatedAgo}</span>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ProjectBoardView;
