// ============================================================================
// ProjectListView.tsx — Dense table view for projects
// ============================================================================
// Compact tabular layout for scanning many projects quickly.
// ============================================================================

import React from 'react';
import { motion } from 'framer-motion';
import { Icon } from '../../../components/shared/Icon';
import type { ProjectCardVM } from '../../../types/vm.types';

interface ProjectListViewProps {
  projects: ProjectCardVM[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  deletingId: string | null;
}

function statusBadge(status: string): { label: string; classes: string } {
  switch (status) {
    case 'completed':
      return { label: 'Completed', classes: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
    case 'in_progress':
      return { label: 'In Progress', classes: 'text-blue-700 bg-blue-50 border-blue-200' };
    case 'planning':
      return { label: 'Planning', classes: 'text-indigo-700 bg-indigo-50 border-indigo-200' };
    case 'on_hold':
      return { label: 'On Hold', classes: 'text-amber-700 bg-amber-50 border-amber-200' };
    default:
      return { label: status, classes: 'text-gray-600 bg-gray-50 border-gray-200' };
  }
}

function progressPercent(card: ProjectCardVM): number {
  if (card.status === 'completed') return 100;
  if (card.milestonesProgress) return card.milestonesProgress.percent;
  if (card.status === 'planning') return 10;
  if (card.status === 'in_progress') return 50;
  return 0;
}

export const ProjectListView: React.FC<ProjectListViewProps> = ({
  projects,
  onOpen,
  onDelete,
  deletingId,
}) => {
  return (
    <div className="bg-white border border-gray-200 rounded-2xl overflow-x-auto scrollbar-none">
      <div className="min-w-[700px]">
        {/* Header row */}
        <div className="grid grid-cols-[1fr_110px_80px_80px_100px_44px] gap-4 px-5 py-3 border-b border-gray-100 bg-gray-50/50">
          <span className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider">Project</span>
          <span className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider">Status</span>
          <span className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider text-right">Progress</span>
          <span className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider text-right">Stars</span>
          <span className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider text-right">Updated</span>
          <span />
        </div>

        {/* Rows */}
      {projects.map((p, i) => {
        const status = statusBadge(p.status);
        const progress = progressPercent(p);
        const isDeleting = deletingId === p.id;

        return (
          <motion.div
            key={p.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: isDeleting ? 0.3 : 1 }}
            transition={{ duration: 0.2, delay: i * 0.02 }}
            onClick={(event) => {
              event.currentTarget.querySelector<HTMLButtonElement>('[data-project-open]')?.focus();
              onOpen(p.id);
            }}
            className={[
              'group grid grid-cols-[1fr_110px_80px_80px_100px_44px] gap-4 px-5 py-3.5 items-center cursor-pointer',
              'border-b border-gray-50 last:border-b-0',
              'hover:bg-gray-50/60 transition-colors duration-150',
              isDeleting ? 'pointer-events-none' : '',
            ].join(' ')}
          >
            {/* Name + description */}
            <div className="min-w-0">
              <h4 className="text-[13.5px] font-semibold text-dt-text truncate leading-snug">
                <button type="button" data-project-open onClick={(event) => { event.stopPropagation(); onOpen(p.id); }} className="text-left focus-visible:outline-2 focus-visible:outline-dt-primary">
                  {p.name}
                </button>
              </h4>
              {p.techStack.length > 0 && (
                <div className="flex items-center gap-1.5 mt-0.5">
                  {p.techStack.slice(0, 3).map(t => (
                    <span key={t} className="text-[10px] text-dt-textMuted font-medium">{t}</span>
                  ))}
                  {p.techStack.length > 3 && (
                    <span className="text-[10px] text-dt-textMuted">+{p.techStack.length - 3}</span>
                  )}
                </div>
              )}
            </div>

            {/* Status */}
            <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${status.classes} w-fit`}>
              {status.label}
            </span>

            {/* Progress */}
            <div className="text-right">
              <span className="text-[13px] font-bold text-dt-text tabular-nums">{progress}%</span>
            </div>

            {/* Stars */}
            <div className="text-right">
              <span className="text-[13px] font-medium text-dt-textSecondary tabular-nums">{p.stars}</span>
            </div>

            {/* Updated */}
            <div className="text-right">
              <span className="text-[11px] text-dt-textMuted font-medium">{p.updatedAgo}</span>
            </div>

            {/* Delete */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
              className="w-8 h-8 rounded-lg hover:bg-red-50 flex items-center justify-center text-gray-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              title="Delete"
              aria-label={`Delete ${p.name}`}
            >
              <Icon name="trash" size={14} />
            </button>
          </motion.div>
        );
      })}

      {projects.length === 0 && (
        <div className="py-12 text-center">
          <p className="text-[13px] text-dt-textMuted">No projects to display</p>
        </div>
      )}
      </div>
    </div>
  );
};

export default ProjectListView;
