import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageShell } from '../components/layout/PageShell';
import { Icon, type IconName } from '../components/shared/Icon';
import { NetworkErrorPanel } from '../components/shared/NetworkErrorPanel';
import { EmptyState } from '../components/shared/EmptyState';
import { ConfirmationModal } from '../components/ui/ConfirmationModal';
import { useDialogFocus } from '../components/ui/useDialogFocus';
import { useProjectsData } from '../hooks/useProjectsData';
import { ProjectDetailDrawer } from '../features/projects/components/ProjectDetailDrawer';
import { ProjectListView } from '../features/projects/components/ProjectListView';
import githubLogo from '../assets/logos/github.png';
import { motion } from 'framer-motion';
import type { ProjectCardVM } from '../types/vm.types';
import type { ApiProjectCreatePayload } from '../types/api.types';

const ProjectBoardView = React.lazy(() =>
  import('../features/projects/components/ProjectBoardView').then((m) => ({ default: m.ProjectBoardView }))
);

/* ─── Types ─── */
type ProjectFilter = 'All' | 'Active' | 'Completed';
type ViewMode = 'grid' | 'list' | 'board';

/* ─── Helpers ─── */
const FILTERS: ProjectFilter[] = ['All', 'Active', 'Completed'];

function statusConfig(status: string): { label: string; color: string; bg: string; dot: string } {
  switch (status) {
    case 'completed':
      return { label: 'Completed', color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500' };
    case 'in_progress':
      return { label: 'In Progress', color: 'text-dt-primary', bg: 'bg-dt-mutedPurple border-dt-primary/20', dot: 'bg-dt-primary' };
    case 'planning':
      return { label: 'Planning', color: 'text-indigo-600', bg: 'bg-indigo-50 border-indigo-200', dot: 'bg-indigo-500' };
    case 'on_hold':
      return { label: 'On Hold', color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500' };
    default:
      return { label: status, color: 'text-dt-textSecondary', bg: 'bg-gray-50 border-gray-200', dot: 'bg-gray-400' };
  }
}

function progressBarGradient(status: string): string {
  switch (status) {
    case 'completed':
      return 'from-emerald-500 to-emerald-400';
    case 'in_progress':
      return 'from-dt-primary to-dt-secondary';
    case 'planning':
      return 'from-indigo-500 to-indigo-400';
    default:
      return 'from-gray-400 to-gray-300';
  }
}

function isActiveStatus(status: string): boolean {
  return status === 'in_progress' || status === 'planning';
}

function statusProgress(card: ProjectCardVM): number {
  if (card.status === 'completed') return 100;
  if (card.milestonesProgress) return card.milestonesProgress.percent;
  if (card.status === 'planning') return 10;
  if (card.status === 'in_progress') return 50;
  return 0;
}

/* ─── Create Project Modal ─── */
export const CreateProjectModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCreate: (payload: ApiProjectCreatePayload) => Promise<void>;
}> = ({ open, onClose, onCreate }) => {
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const titleId = React.useId();
  const descriptionId = React.useId();
  const [form, setForm] = React.useState({
    name: '',
    description: '',
    repoUrl: '',
    liveUrl: '',
    techStack: '',
    status: 'planning' as const,
    visibility: 'private' as const,
  });
  const [saving, setSaving] = React.useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await onCreate({
        name: form.name.trim(),
        description: form.description.trim(),
        repoUrl: form.repoUrl.trim() || undefined,
        liveUrl: form.liveUrl.trim() || undefined,
        techStack: form.techStack
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        status: form.status,
        visibility: form.visibility,
      });
      onClose();
      setForm({ name: '', description: '', repoUrl: '', liveUrl: '', techStack: '', status: 'planning', visibility: 'private' });
    } catch {
      // Error is handled by the hook
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <motion.div
        ref={dialogRef}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className="bg-white border border-gray-200 rounded-2xl shadow-2xl w-full max-w-lg p-8 mx-4"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 id={titleId} className="text-xl font-bold text-dt-text tracking-tight">New Project</h2>
            <p id={descriptionId} className="text-sm text-dt-textSecondary mt-1">Set up a new project workspace</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close new project dialog" className="w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 cursor-pointer transition-colors flex items-center justify-center">
            <Icon name="x-mark" size={18} className="text-dt-textSecondary" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label className="text-sm font-semibold text-dt-text mb-1.5 block">Project Name</label>
            <input
              type="text"
              data-dialog-initial-focus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="dt-input w-full"
              placeholder="My awesome project..."
              required
            />
          </div>

          <div>
            <label className="text-sm font-semibold text-dt-text mb-1.5 block">Description</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="dt-input w-full resize-none"
              rows={3}
              placeholder="What is this project about?"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-semibold text-dt-text mb-1.5 block">Status</label>
              <div className="relative">
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as typeof form.status })}
                  className="dt-input dt-select w-full cursor-pointer"
                >
                  <option value="planning">Planning</option>
                  <option value="in_progress">In Progress</option>
                  <option value="completed">Completed</option>
                  <option value="on_hold">On Hold</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-sm font-semibold text-dt-text mb-1.5 block">Visibility</label>
              <div className="relative">
                <select
                  value={form.visibility}
                  onChange={(e) => setForm({ ...form, visibility: e.target.value as typeof form.visibility })}
                  className="dt-input dt-select w-full cursor-pointer"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </div>
            </div>
          </div>

          <div>
            <label className="text-sm font-semibold text-dt-text mb-1.5 block">Tech Stack</label>
            <input
              type="text"
              value={form.techStack}
              onChange={(e) => setForm({ ...form, techStack: e.target.value })}
              className="dt-input w-full"
              placeholder="React, TypeScript, Node.js..."
            />
          </div>

          <div>
            <label className="text-sm font-semibold text-dt-text mb-1.5 block">Repository URL</label>
            <input
              type="url"
              value={form.repoUrl}
              onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
              className="dt-input w-full"
              placeholder="https://github.com/..."
            />
          </div>

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="dt-btn dt-btn-ghost dt-btn-md px-5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !form.name.trim()}
              className="dt-btn dt-btn-primary dt-btn-md px-8"
            >
              {saving ? 'Creating…' : 'Create Project'}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
};

/* ─── Project Card (Cleaned Up — Real Data Only) ─── */
const ProjectCard: React.FC<{
  project: ProjectCardVM;
  index: number;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
  isDeleting: boolean;
}> = React.memo(({ project: p, index, onDelete, onOpen, isDeleting }) => {
  const progress = statusProgress(p);
  const status = statusConfig(p.status);
  const isActive = isActiveStatus(p.status);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.5, delay: index * 0.08, ease: [0.16, 1, 0.3, 1] }}
      onClick={(event) => {
        event.currentTarget.querySelector<HTMLButtonElement>('[data-project-open]')?.focus();
        onOpen(p.id);
      }}
      className={[
        'group/card bg-white border border-gray-200/80 rounded-2xl overflow-hidden cursor-pointer',
        'hover:border-dt-primary/25 hover:shadow-[0_12px_40px_rgba(124,92,252,0.08)]',
        'transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
        isDeleting ? 'opacity-40 scale-[0.98] pointer-events-none' : '',
      ].join(' ')}
    >
      {/* Progress bar accent at top */}
      <div className="h-1 w-full bg-gray-100 relative">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 1, ease: 'circOut', delay: index * 0.1 + 0.3 }}
          className={`h-full bg-gradient-to-r ${progressBarGradient(p.status)}`}
        />
      </div>

      <div className="p-6">
        {/* Header: Icon + Name + Status */}
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-gray-50 border border-gray-200 flex items-center justify-center shrink-0 relative overflow-hidden group-hover/card:border-dt-primary/20 transition-colors">
              <img src={githubLogo} alt="" className="w-5.5 h-5.5 object-contain opacity-70 group-hover/card:opacity-100 transition-opacity" />
              {isActive && (
                <div className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 border-[1.5px] border-white"></span>
                </div>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-[17px] font-bold text-dt-text tracking-tight leading-snug truncate group-hover/card:text-dt-primary transition-colors duration-300">
                <button type="button" data-project-open onClick={(event) => { event.stopPropagation(); onOpen(p.id); }} className="text-left focus-visible:outline-2 focus-visible:outline-dt-primary">
                  {p.name}
                </button>
              </h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider border ${status.bg} ${status.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
                  {status.label}
                </span>
                <span className="text-[11px] text-dt-textMuted font-medium">{p.updatedAgo}</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
            className="w-8 h-8 rounded-lg hover:bg-red-50 flex items-center justify-center transition-all duration-200 opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 text-gray-400 hover:text-red-500 shrink-0"
            aria-label={`Delete ${p.name}`}
            title="Delete project"
          >
            <Icon name="trash" size={15} />
          </button>
        </div>

        {/* Description */}
        <p className="text-[13.5px] text-dt-textSecondary leading-relaxed line-clamp-2 mb-5">
          {p.description || 'No description provided.'}
        </p>

        {/* Real Metrics Row */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          {[
            {
              label: 'Progress',
              value: `${progress}%`,
              icon: 'activity' as IconName,
              color: 'text-dt-primary',
            },
            {
              label: 'Stars',
              value: p.stars || '0',
              icon: 'star' as IconName,
              color: 'text-amber-500',
            },
            {
              label: 'Issues',
              value: p.openIssues || '0',
              icon: 'exclamation-circle' as IconName,
              color: 'text-rose-500',
            },
          ].map((metric) => (
            <div
              key={metric.label}
              className="flex flex-col gap-1.5 p-3 rounded-xl bg-gray-50/80 border border-gray-100"
            >
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-semibold text-dt-textMuted uppercase tracking-wider">{metric.label}</span>
                <Icon name={metric.icon} size={12} className={metric.color} />
              </div>
              <span className={`text-[15px] font-bold text-dt-text tracking-tight tabular-nums`}>{metric.value}</span>
            </div>
          ))}
        </div>

        {/* Progress bar */}
        {p.milestonesProgress && (
          <div className="mb-5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold text-dt-textSecondary">Milestones</span>
              <span className="text-[11px] font-bold text-dt-textSecondary tabular-nums">
                {p.milestonesProgress.completed}/{p.milestonesProgress.total}
              </span>
            </div>
            <div className="h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${p.milestonesProgress.percent}%` }}
                transition={{ duration: 1, ease: 'circOut' }}
                className={`h-full rounded-full bg-gradient-to-r ${progressBarGradient(p.status)}`}
              />
            </div>
          </div>
        )}

        {/* Tech stack tags */}
        {p.techStack.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-5">
            {p.techStack.slice(0, 5).map((tag) => (
              <span
                key={tag}
                className="px-2.5 py-1 rounded-md bg-gray-50 border border-gray-150 text-[11px] font-semibold text-dt-textSecondary tracking-wide"
              >
                {tag}
              </span>
            ))}
            {p.techStack.length > 5 && (
              <span className="px-2.5 py-1 rounded-md bg-gray-50 border border-gray-150 text-[11px] font-semibold text-dt-textMuted">
                +{p.techStack.length - 5}
              </span>
            )}
          </div>
        )}

        {/* Footer: Links */}
        <div className="flex items-center gap-2 pt-4 border-t border-gray-100">
          {p.repoUrl && (
            <button
              onClick={(event) => { event.stopPropagation(); window.open(p.repoUrl!, '_blank'); }}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-gray-50 hover:bg-gray-100 border border-gray-200 text-[12px] font-semibold text-dt-textSecondary hover:text-dt-text transition-all duration-200 group/link"
            >
              <Icon name="github" size={14} className="opacity-60 group-hover/link:opacity-100 transition-opacity" />
              Source
            </button>
          )}
          {p.liveUrl && (
            <button
              onClick={(event) => { event.stopPropagation(); window.open(p.liveUrl!, '_blank'); }}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-dt-primary/5 hover:bg-dt-primary/10 border border-dt-primary/10 text-[12px] font-semibold text-dt-primary hover:text-dt-primary transition-all duration-200 group/link"
            >
              <Icon name="external-link" size={14} className="opacity-70 group-hover/link:opacity-100 transition-opacity" />
              Live
            </button>
          )}
          <div className="flex-1" />
          {p.lastCommit && (
            <span className="text-[11px] text-dt-textMuted font-medium flex items-center gap-1.5">
              <Icon name="clock" size={12} className="opacity-50" />
              {p.lastCommit}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
});

/* ─── Main Page Component ─── */
const ProjectsPage: React.FC = () => {
  const {
    data,
    status,
    error,
    refresh,
    createProject,
    deleteProject,
  } = useProjectsData();

  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = React.useState<ProjectFilter>('All');
  const [mounted, setMounted] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = React.useState<string | null>(null);
  const [viewMode, setViewMode] = React.useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [techFilter, setTechFilter] = React.useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = React.useState(false);
  const [projectToDelete, setProjectToDelete] = React.useState<string | null>(null);

  React.useEffect(() => {
    setMounted(true);
    const p = searchParams.get('project');
    if (p) {
      setSelectedProjectId(p);
    }
  }, [searchParams]);

  // Keyboard shortcuts: N → new project, G → grid, L → list
  React.useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (showCreate || selectedProjectId) return;

      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setShowCreate(true); }
      if (e.key === 'g' || e.key === 'G') { e.preventDefault(); setViewMode('grid'); }
      if (e.key === 'l' || e.key === 'L') { e.preventDefault(); setViewMode('list'); }
      if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setViewMode('board'); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [showCreate, selectedProjectId]);

  const projects = React.useMemo(() => data?.projects ?? [], [data]);

  const filteredProjects = React.useMemo(() => {
    let result = projects;

    // Status filter
    if (filter === 'Completed') result = result.filter((p) => p.status === 'completed');
    else if (filter === 'Active') result = result.filter((p) => isActiveStatus(p.status));

    // Tech stack filter
    if (techFilter) {
      result = result.filter((p) => p.techStack.some(t => t.toLowerCase() === techFilter.toLowerCase()));
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        p.techStack.some(t => t.toLowerCase().includes(q))
      );
    }

    return result;
  }, [filter, projects, searchQuery, techFilter]);

  // Unique tech stack tags across all projects
  const allTechTags = React.useMemo(() => {
    const tags = new Set<string>();
    for (const p of projects) {
      for (const t of p.techStack) tags.add(t);
    }
    return Array.from(tags).sort();
  }, [projects]);

  const handleDelete = (id: string) => {
    setProjectToDelete(id);
    setDeleteConfirmOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!projectToDelete) return;
    const id = projectToDelete;
    setDeleteConfirmOpen(false);
    setProjectToDelete(null);
    setDeletingId(id);
    try {
      await deleteProject(id);
    } catch {
      // Handled by hook
    } finally {
      setDeletingId(null);
    }
  };

  /* ─── Filter Tabs ─── */
  const filterTabs = (
    <div className="flex items-center gap-1 bg-gray-100/80 rounded-xl p-1">
      {FILTERS.map((key) => {
        const isSelected = filter === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={[
              'relative px-4 py-2 text-[12px] font-semibold rounded-lg cursor-pointer transition-all duration-200',
              isSelected
                ? 'bg-white text-dt-text shadow-sm'
                : 'text-dt-textSecondary hover:text-dt-text',
            ].join(' ')}
          >
            {key}
          </button>
        );
      })}
    </div>
  );

  /* ─── Header Actions ─── */
  const headerActions = (
    <div className="flex items-center gap-3">
      {filterTabs}

      {/* View Toggle */}
      <div className="flex items-center gap-0.5 bg-gray-100/80 rounded-lg p-0.5">
        <button
          type="button"
          onClick={() => setViewMode('grid')}
          className={[
            'p-1.5 rounded-md transition-all duration-200',
            viewMode === 'grid' ? 'bg-white shadow-sm text-dt-text' : 'text-dt-textMuted hover:text-dt-text',
          ].join(' ')}
          title="Grid view (G)"
          aria-label="Grid view"
        >
          <Icon name="squares-2x2" size={15} />
        </button>
        <button
          type="button"
          onClick={() => setViewMode('board')}
          className={[
            'p-1.5 rounded-md transition-all duration-200',
            viewMode === 'board' ? 'bg-white shadow-sm text-dt-text' : 'text-dt-textMuted hover:text-dt-text',
          ].join(' ')}
          title="Board view (B)"
          aria-label="Board view"
        >
          <Icon name="view-columns" size={15} />
        </button>
        <button
          type="button"
          onClick={() => setViewMode('list')}
          className={[
            'p-1.5 rounded-md transition-all duration-200',
            viewMode === 'list' ? 'bg-white shadow-sm text-dt-text' : 'text-dt-textMuted hover:text-dt-text',
          ].join(' ')}
          title="List view (L)"
          aria-label="List view"
        >
          <Icon name="bars-3" size={15} />
        </button>
      </div>

      <button
        type="button"
        onClick={() => setShowCreate(true)}
        className="dt-btn dt-btn-primary dt-btn-md px-5 gap-2"
      >
        <Icon name="plus" size={14} className="text-white" />
        New Project
      </button>
    </div>
  );

  /* ─── Loading Skeleton ─── */
  // Show network-aware error panel instead of crashing the entire page
  const handleRetry = React.useCallback(() => { refresh(); }, [refresh]);

  if (status === 'error' && error && !data) {
    return <NetworkErrorPanel error={error} onRetry={handleRetry} variant="centered" />;
  }

  if (status === 'loading' && !data) {
    return (
      <PageShell title="Projects" subtitle="Manage your development workspaces" status="loading" error={null}>
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-2xl p-6 animate-pulse">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-11 h-11 rounded-xl bg-gray-100" />
                <div className="flex-1">
                  <div className="h-4 bg-gray-100 rounded w-2/3 mb-2" />
                  <div className="h-3 bg-gray-100 rounded w-1/3" />
                </div>
              </div>
              <div className="h-3 bg-gray-50 rounded w-full mb-2" />
              <div className="h-3 bg-gray-50 rounded w-4/5 mb-5" />
              <div className="grid grid-cols-3 gap-3 mb-5">
                {[1, 2, 3].map((j) => (
                  <div key={j} className="h-16 bg-gray-50 rounded-xl" />
                ))}
              </div>
              <div className="h-1 bg-gray-50 rounded-full" />
            </div>
          ))}
        </div>
      </PageShell>
    );
  }

  return (
    <div className={['transition-all duration-700', mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'].join(' ')}>
      <PageShell
        title="Projects"
        subtitle="Manage your development workspaces"
        status={status === 'loading' ? 'success' : status}
        error={error}
        actions={headerActions}
        onRetry={refresh}
      >
        <div className="relative z-10 mx-auto w-full max-w-[1400px]">
          {/* Stats & Search bar */}
          {projects.length > 0 && (
            <div className="flex items-center justify-between gap-6 mb-6">
              <div className="flex items-center gap-6 text-[13px]">
                <span className="text-dt-textSecondary font-medium">
                  <span className="font-bold text-dt-text tabular-nums">{filteredProjects.length}</span>{filteredProjects.length !== projects.length ? ` of ${projects.length}` : ''} projects
                </span>
                <span className="w-1 h-1 rounded-full bg-gray-300" />
                <span className="text-dt-textSecondary font-medium">
                  <span className="font-bold text-emerald-600 tabular-nums">{projects.filter(p => isActiveStatus(p.status)).length}</span> active
                </span>
              </div>

              {/* Search */}
              <div className="relative">
                <Icon name="magnifying-glass" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dt-textMuted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search projects..."
                  className="w-[220px] pl-8 pr-3 py-2 text-[12px] font-medium text-dt-text bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-dt-primary/40 focus:bg-white transition-all placeholder:text-dt-textMuted"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-dt-textMuted hover:text-dt-text"
                  >
                    <Icon name="x-mark" size={12} />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Tech stack filter pills */}
          {allTechTags.length > 0 && projects.length > 0 && (
            <div className="flex items-center gap-1.5 mb-6 flex-wrap">
              <span className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider mr-1">Stack:</span>
              {techFilter && (
                <button
                  onClick={() => setTechFilter(null)}
                  className="px-2 py-0.5 rounded-md text-[10px] font-semibold text-dt-primary bg-dt-primary/5 border border-dt-primary/10 hover:bg-dt-primary/10 transition-colors"
                >
                  Clear
                </button>
              )}
              {allTechTags.map(tag => (
                <button
                  key={tag}
                  onClick={() => setTechFilter(techFilter === tag ? null : tag)}
                  className={[
                    'px-2 py-0.5 rounded-md text-[10px] font-semibold border transition-all',
                    techFilter === tag
                      ? 'text-dt-primary bg-dt-primary/10 border-dt-primary/20'
                      : 'text-dt-textSecondary bg-gray-50 border-gray-200 hover:border-gray-300',
                  ].join(' ')}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {/* Empty State */}
          {filteredProjects.length === 0 ? (
            <EmptyState
              title={projects.length === 0 ? 'No projects yet' : 'No matching projects'}
              description={projects.length === 0 ? 'Create your first project to start tracking your development work.' : 'Try adjusting your filters to find what you\'re looking for.'}
              icon="folder"
              action={
                projects.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setShowCreate(true)}
                    className="dt-btn dt-btn-primary dt-btn-md px-6 gap-2 mt-4"
                  >
                    <Icon name="plus" size={16} className="text-white" />
                    Create Project
                  </button>
                )
              }
            />
          ) : viewMode === 'grid' ? (
            /* ─── Project Grid ─── */
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5 pb-16">
              {filteredProjects.map((p, index) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  index={index}
                  onDelete={handleDelete}
                  onOpen={setSelectedProjectId}
                  isDeleting={deletingId === p.id}
                />
              ))}
            </div>
          ) : viewMode === 'board' ? (
            /* ─── Project Board (Kanban) ─── */
            <React.Suspense fallback={
              <div className="h-[400px] flex items-center justify-center bg-white border border-gray-200/80 rounded-2xl animate-pulse">
                <span className="text-xs font-semibold text-dt-textMuted tracking-wider uppercase">Loading Board View…</span>
              </div>
            }>
              <ProjectBoardView
                projects={filteredProjects}
                onOpen={setSelectedProjectId}
                onDelete={handleDelete}
                deletingId={deletingId}
              />
            </React.Suspense>
          ) : (
            /* ─── Project List ─── */
            <div className="pb-16">
              <ProjectListView
                projects={filteredProjects}
                onOpen={setSelectedProjectId}
                onDelete={handleDelete}
                deletingId={deletingId}
              />
            </div>
          )}
        </div>
      </PageShell>

      {/* ─── Create Modal ─── */}
      <CreateProjectModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={createProject}
      />

      {/* ─── Project Detail Drawer ─── */}
      <ProjectDetailDrawer
        projectId={selectedProjectId}
        onClose={() => {
          setSelectedProjectId(null);
          setSearchParams(new URLSearchParams());
        }}
      />

      {/* ─── Delete Confirmation Modal ─── */}
      <ConfirmationModal
        isOpen={deleteConfirmOpen}
        title="Delete Project"
        message="Are you sure you want to permanently delete this project? All associated tasks, activity logs, and settings will be permanently lost."
        confirmLabel="Delete Project"
        cancelLabel="Keep Project"
        type="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setDeleteConfirmOpen(false);
          setProjectToDelete(null);
        }}
      />
    </div>
  );
};

export default ProjectsPage;
