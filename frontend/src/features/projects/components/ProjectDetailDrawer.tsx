// ============================================================================
// ProjectDetailDrawer.tsx — Slide-out drawer for project details & task board
// ============================================================================
// Features: DnD kanban (via @dnd-kit), inline task creation, task detail editor,
// milestone timeline, and project overview with real metrics.
// ============================================================================

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon, type IconName } from '../../../components/shared/Icon';
import { useProjectDetail } from '../../../hooks/useProjectsData';
import { useDialogFocus } from '../../../components/ui/useDialogFocus';
import { createProjectTask, updateProjectTask } from '../../../services/projectsService';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { ActivityFeed } from './ActivityFeed';
import { useUIStore } from '../../../store/uiStore';
import type { ProjectTaskVM, ProjectDetailVM } from '../../../types/vm.types';

/* ─── Types ─── */
type TaskColumn = 'todo' | 'in_progress' | 'review' | 'done';
type DrawerTab = 'overview' | 'tasks' | 'milestones' | 'activity';

interface ProjectDetailDrawerProps {
  projectId: string | null;
  onClose: () => void;
}

/* ─── Column Config ─── */
const COLUMNS: { key: TaskColumn; label: string; color: string; bgColor: string; icon: IconName }[] = [
  { key: 'todo', label: 'To Do', color: 'text-gray-500', bgColor: 'bg-gray-100', icon: 'circle' },
  { key: 'in_progress', label: 'In Progress', color: 'text-blue-600', bgColor: 'bg-blue-50', icon: 'clock' },
  { key: 'review', label: 'Review', color: 'text-amber-600', bgColor: 'bg-amber-50', icon: 'eye' },
  { key: 'done', label: 'Done', color: 'text-emerald-600', bgColor: 'bg-emerald-50', icon: 'check-circle' },
];

const PRIORITY_CONFIG: Record<string, { color: string; bg: string }> = {
  critical: { color: 'text-red-600', bg: 'bg-red-50 border-red-200' },
  high: { color: 'text-orange-600', bg: 'bg-orange-50 border-orange-200' },
  medium: { color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200' },
  low: { color: 'text-gray-500', bg: 'bg-gray-50 border-gray-200' },
};

/* ─── Helper: normalize status label → column key ─── */
function toColumnKey(statusLabel: string): TaskColumn {
  const normalized = statusLabel.toLowerCase().replace(/\s+/g, '_');
  if (['todo', 'in_progress', 'review', 'done'].includes(normalized)) {
    return normalized as TaskColumn;
  }
  return 'todo';
}

/* ─── Inline Task Creator ─── */
const InlineTaskCreator: React.FC<{
  projectId: string;
  status: TaskColumn;
  onCreated: () => void;
}> = ({ projectId, status, onCreated }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const handleSubmit = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    try {
      await createProjectTask(projectId, {
        title: title.trim(),
        description: '',
        status,
        priority: 'medium',
        labels: [],
        dueDate: null,
        assigneeId: null,
        milestoneId: null,
      });
      setTitle('');
      setIsOpen(false);
      onCreated();
    } catch {
      // handled
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    if (e.key === 'Escape') { e.stopPropagation(); setIsOpen(false); setTitle(''); }
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="w-full py-2 text-[12px] font-medium text-dt-textMuted hover:text-dt-primary border border-dashed border-gray-200 hover:border-dt-primary/30 rounded-lg transition-colors cursor-pointer flex items-center justify-center gap-1.5"
      >
        <Icon name="plus" size={12} />
        Add task
      </button>
    );
  }

  return (
    <div className="border border-dt-primary/20 rounded-lg p-2 bg-white shadow-sm">
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Task title..."
        className="w-full text-[13px] font-medium text-dt-text bg-transparent outline-none placeholder:text-dt-textMuted"
        disabled={saving}
      />
      <div className="flex items-center justify-end gap-1.5 mt-2">
        <button
          onClick={() => { setIsOpen(false); setTitle(''); }}
          className="px-2.5 py-1 text-[11px] font-medium text-dt-textSecondary hover:text-dt-text rounded-md hover:bg-gray-100 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!title.trim() || saving}
          className="px-2.5 py-1 text-[11px] font-semibold text-white bg-dt-primary rounded-md hover:bg-dt-primary/90 disabled:opacity-40 transition-colors"
        >
          {saving ? '...' : 'Add'}
        </button>
      </div>
    </div>
  );
};

/* ─── Sortable Task Card (DnD-enabled) ─── */
const SortableTaskCard: React.FC<{
  task: ProjectTaskVM;
  onEdit: (task: ProjectTaskVM) => void;
}> = React.memo(({ task, onEdit }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { task } });

  const priority = PRIORITY_CONFIG[task.priorityLabel.toLowerCase()] || PRIORITY_CONFIG.medium;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onEdit(task)}
      className={[
        'bg-white border border-gray-200 rounded-xl p-3 cursor-grab active:cursor-grabbing',
        'hover:border-dt-primary/20 hover:shadow-sm transition-all duration-150 group/task',
        isDragging ? 'shadow-lg ring-2 ring-dt-primary/20' : '',
      ].join(' ')}
    >
      <p className="text-[13px] font-medium text-dt-text leading-snug line-clamp-2 mb-2">
        <button type="button" onClick={(event) => { event.stopPropagation(); onEdit(task); }} onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation(); }} className="text-left focus-visible:outline-2 focus-visible:outline-dt-primary">
          {task.title}
        </button>
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${priority.bg} ${priority.color}`}>
          <Icon name={task.priorityIcon as IconName} size={9} />
          {task.priorityLabel}
        </span>
        {task.dueDate && (
          <span className={`text-[10px] font-medium ${task.isOverdue ? 'text-red-500' : 'text-dt-textMuted'}`}>
            {task.dueDate}
          </span>
        )}
        {task.labels.slice(0, 2).map((label) => (
          <span key={label} className="px-1.5 py-0.5 rounded text-[9px] font-medium text-dt-textSecondary bg-gray-100">
            {label}
          </span>
        ))}
      </div>
    </div>
  );
});

/* ─── Static Task Card (for DragOverlay) ─── */
const TaskCardOverlay: React.FC<{ task: ProjectTaskVM }> = ({ task }) => {
  const priority = PRIORITY_CONFIG[task.priorityLabel.toLowerCase()] || PRIORITY_CONFIG.medium;
  return (
    <div className="bg-white border border-dt-primary/30 rounded-xl p-3 shadow-xl ring-2 ring-dt-primary/10 rotate-[2deg] scale-105 w-[160px]">
      <p className="text-[13px] font-medium text-dt-text leading-snug line-clamp-2 mb-2">
        {task.title}
      </p>
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${priority.bg} ${priority.color}`}>
        {task.priorityLabel}
      </span>
    </div>
  );
};

/* ─── Droppable Column ─── */
const DroppableColumn: React.FC<{
  column: typeof COLUMNS[number];
  tasks: ProjectTaskVM[];
  projectId: string;
  onRefresh: () => void;
  onEditTask: (task: ProjectTaskVM) => void;
}> = ({ column, tasks, projectId, onRefresh, onEditTask }) => {
  const { setNodeRef } = useSortable({
    id: `column-${column.key}`,
    data: { type: 'column', column: column.key },
  });

  return (
    <div ref={setNodeRef} className="flex flex-col gap-2">
      {/* Column header */}
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-5 h-5 rounded-md ${column.bgColor} flex items-center justify-center`}>
          <Icon name={column.icon} size={11} className={column.color} />
        </div>
        <span className="text-[11px] font-bold text-dt-text uppercase tracking-wider">{column.label}</span>
        <span className="text-[11px] font-medium text-dt-textMuted ml-auto tabular-nums">
          {tasks.length}
        </span>
      </div>

      {/* Tasks */}
      <SortableContext
        items={tasks.map(t => t.id)}
        strategy={verticalListSortingStrategy}
        id={column.key}
      >
        <div className="flex flex-col gap-2 min-h-[60px] p-1 rounded-lg transition-colors">
          {tasks.map((task) => (
            <SortableTaskCard key={task.id} task={task} onEdit={onEditTask} />
          ))}
        </div>
      </SortableContext>

      {/* Inline add */}
      <InlineTaskCreator projectId={projectId} status={column.key} onCreated={onRefresh} />
    </div>
  );
};

/* ─── Task Board (DnD Kanban) ─── */
const TaskBoard: React.FC<{
  tasks: ProjectTaskVM[];
  projectId: string;
  onRefresh: () => void;
}> = ({ tasks, projectId, onRefresh }) => {
  const [activeTask, setActiveTask] = useState<ProjectTaskVM | null>(null);
  const [editingTask, setEditingTask] = useState<ProjectTaskVM | null>(null);
  
  // Local state to keep track of tasks during optimistic updates
  const [localTasks, setLocalTasks] = useState<ProjectTaskVM[]>(tasks);
  const addToast = useUIStore((s) => s.addToast);

  // Sync localTasks when tasks prop changes
  useEffect(() => {
    setLocalTasks(tasks);
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const groupedTasks = useMemo(() => {
    const groups: Record<TaskColumn, ProjectTaskVM[]> = {
      todo: [], in_progress: [], review: [], done: [],
    };
    for (const task of localTasks) {
      const col = toColumnKey(task.statusLabel);
      groups[col].push(task);
    }
    return groups;
  }, [localTasks]);

  const handleDragStart = (event: DragStartEvent) => {
    const task = event.active.data.current?.task as ProjectTaskVM | undefined;
    if (task) setActiveTask(task);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const draggedTask = active.data.current?.task as ProjectTaskVM | undefined;
    if (!draggedTask) return;

    // Determine target column
    let targetColumn: TaskColumn | null = null;

    // Dropped on a column directly
    if (over.data.current?.type === 'column') {
      targetColumn = over.data.current.column as TaskColumn;
    }
    // Dropped on another task — find which column it belongs to
    else if (over.data.current?.task) {
      const overTask = over.data.current.task as ProjectTaskVM;
      targetColumn = toColumnKey(overTask.statusLabel);
    }
    // Dropped on a sortable context (column id)
    else if (typeof over.id === 'string' && over.id.startsWith('column-')) {
      targetColumn = over.id.replace('column-', '') as TaskColumn;
    }

    if (!targetColumn) return;

    const currentColumn = toColumnKey(draggedTask.statusLabel);
    if (currentColumn === targetColumn) return;

    // Optimistic: update local tasks immediately
    const previousTasks = [...localTasks];
    
    // Map column key to appropriate display label and color
    const labelMapping: Record<TaskColumn, string> = {
      todo: 'Todo',
      in_progress: 'In progress',
      review: 'Review',
      done: 'Done',
    };
    
    const colorMapping: Record<TaskColumn, string> = {
      todo: '#6B7280',
      in_progress: '#3B82F6',
      review: '#8B5CF6',
      done: '#10B981',
    };

    const iconMapping: Record<TaskColumn, string> = {
      todo: 'circle',
      in_progress: 'clock',
      review: 'eye',
      done: 'check-circle',
    };

    const updatedTasks = localTasks.map((t) => {
      if (t.id === draggedTask.id) {
        return {
          ...t,
          statusLabel: labelMapping[targetColumn!],
          statusColor: colorMapping[targetColumn!],
          statusIcon: iconMapping[targetColumn!],
        };
      }
      return t;
    });

    setLocalTasks(updatedTasks);

    try {
      await updateProjectTask(projectId, draggedTask.id, { status: targetColumn as any });
      onRefresh(); // Trigger parent refetch to sync official server state
    } catch (err) {
      // Revert to pre-drag state
      setLocalTasks(previousTasks);
      addToast({
        type: 'error',
        title: 'Failed to update task status',
        message: 'Could not sync status change with server.',
        duration: 4000,
      });
    }
  };

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex overflow-x-auto lg:grid lg:grid-cols-4 gap-4 pb-4 scrollbar-none snap-x snap-mandatory [-webkit-overflow-scrolling:touch]">
          {COLUMNS.map((col) => (
            <div key={col.key} className="min-w-[270px] sm:min-w-[310px] lg:min-w-0 snap-align-start shrink-0">
              <DroppableColumn
                column={col}
                tasks={groupedTasks[col.key]}
                projectId={projectId}
                onRefresh={onRefresh}
                onEditTask={setEditingTask}
              />
            </div>
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeTask && <TaskCardOverlay task={activeTask} />}
        </DragOverlay>
      </DndContext>

      {/* Task Detail Editor */}
      <TaskDetailDrawer
        task={editingTask}
        projectId={projectId}
        onClose={() => setEditingTask(null)}
        onUpdated={onRefresh}
      />
    </>
  );
};

/* ─── Milestone Timeline ─── */
const MilestoneTimeline: React.FC<{ detail: ProjectDetailVM }> = ({ detail }) => {
  if (detail.milestones.length === 0) {
    return (
      <div className="text-center py-12">
        <Icon name="flag" size={32} className="text-dt-textMuted/30 mx-auto mb-3" />
        <p className="text-sm font-medium text-dt-textMuted">No milestones defined</p>
        <p className="text-xs text-dt-textMuted/60 mt-1">Add milestones to track project progress</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-gray-200" />
      <div className="space-y-6">
        {detail.milestones.map((milestone, i) => {
          const isCompleted = milestone.statusLabel === 'Completed';
          const isCurrent = !isCompleted && i === detail.milestones.findIndex(m => m.statusLabel !== 'Completed');

          return (
            <div key={milestone.id} className="relative flex gap-4 pl-2">
              <div className={`relative z-10 w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                isCompleted ? 'border-emerald-500 bg-emerald-500' :
                isCurrent ? 'border-dt-primary bg-white' :
                'border-gray-300 bg-white'
              }`}>
                {isCompleted && <Icon name="check" size={12} className="text-white" />}
                {isCurrent && <div className="w-2 h-2 rounded-full bg-dt-primary animate-pulse" />}
              </div>

              <div className="flex-1 pb-2">
                <div className="flex items-center gap-2">
                  <h4 className="text-[14px] font-semibold text-dt-text">{milestone.title}</h4>
                  {milestone.isOverdue && (
                    <span className="text-[9px] font-bold text-red-500 uppercase tracking-wider">Overdue</span>
                  )}
                </div>
                {milestone.description && (
                  <p className="text-[12px] text-dt-textSecondary mt-0.5 leading-relaxed">{milestone.description}</p>
                )}
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[11px] font-medium text-dt-textMuted">{milestone.progressLabel}</span>
                  {milestone.dueDate && (
                    <span className={`text-[11px] font-medium ${milestone.isOverdue ? 'text-red-500' : 'text-dt-textMuted'}`}>
                      Due {milestone.dueDate}
                    </span>
                  )}
                </div>
                <div className="h-1 w-full max-w-[200px] bg-gray-100 rounded-full overflow-hidden mt-2">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isCompleted ? 'bg-emerald-500' : 'bg-dt-primary'
                    }`}
                    style={{ width: `${milestone.progress}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ─── Overview Tab ─── */
const OverviewTab: React.FC<{ detail: ProjectDetailVM }> = ({ detail }) => {
  const statusColors: Record<string, string> = {
    planning: 'text-indigo-600 bg-indigo-50 border-indigo-200',
    in_progress: 'text-dt-primary bg-dt-mutedPurple border-dt-primary/20',
    completed: 'text-emerald-600 bg-emerald-50 border-emerald-200',
    on_hold: 'text-amber-600 bg-amber-50 border-amber-200',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider border ${statusColors[detail.status] || 'text-gray-600 bg-gray-50 border-gray-200'}`}>
          {detail.status.replace(/_/g, ' ')}
        </span>
        <span className="text-[11px] text-dt-textMuted">Created {detail.createdFormatted}</span>
        <span className="text-[11px] text-dt-textMuted">Updated {detail.updatedFormatted}</span>
      </div>

      {detail.description && (
        <div>
          <h4 className="text-[11px] font-bold text-dt-textMuted uppercase tracking-wider mb-2">Description</h4>
          <p className="text-[14px] text-dt-textSecondary leading-relaxed">{detail.description}</p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Stars', value: detail.stars, icon: 'star' as IconName, color: 'text-amber-500' },
          { label: 'Forks', value: detail.forks, icon: 'git-branch' as IconName, color: 'text-dt-primary' },
          { label: 'Commits', value: detail.totalCommits, icon: 'git-commit' as IconName, color: 'text-emerald-500' },
          { label: 'Issues', value: detail.openIssues, icon: 'exclamation-circle' as IconName, color: 'text-rose-500' },
        ].map(m => (
          <div key={m.label} className="flex flex-col gap-1.5 p-3 rounded-xl bg-gray-50/80 border border-gray-100">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold text-dt-textMuted uppercase tracking-wider">{m.label}</span>
              <Icon name={m.icon} size={12} className={m.color} />
            </div>
            <span className="text-[16px] font-bold text-dt-text tabular-nums">{m.value}</span>
          </div>
        ))}
      </div>

      {detail.techStack.length > 0 && (
        <div>
          <h4 className="text-[11px] font-bold text-dt-textMuted uppercase tracking-wider mb-2">Tech Stack</h4>
          <div className="flex flex-wrap gap-1.5">
            {detail.techStack.map(tag => (
              <span key={tag} className="px-2.5 py-1 rounded-md bg-gray-50 border border-gray-150 text-[11px] font-semibold text-dt-textSecondary">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        {detail.repoUrl && (
          <a href={detail.repoUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-gray-50 hover:bg-gray-100 border border-gray-200 text-[12px] font-semibold text-dt-textSecondary hover:text-dt-text transition-all">
            <Icon name="github" size={14} />
            Repository
          </a>
        )}
        {detail.liveUrl && (
          <a href={detail.liveUrl} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-dt-primary/5 hover:bg-dt-primary/10 border border-dt-primary/10 text-[12px] font-semibold text-dt-primary transition-all">
            <Icon name="external-link" size={14} />
            Live Site
          </a>
        )}
      </div>
    </div>
  );
};

/* ─── Main Drawer Component ─── */
export const ProjectDetailDrawer: React.FC<ProjectDetailDrawerProps> = ({ projectId, onClose }) => {
  const { data: detail, status, refresh } = useProjectDetail(projectId);
  const [activeTab, setActiveTab] = useState<DrawerTab>('overview');
  const drawerRef = useDialogFocus<HTMLDivElement>(onClose);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  const tabs: { key: DrawerTab; label: string; icon: IconName }[] = [
    { key: 'overview', label: 'Overview', icon: 'chart-bar' },
    { key: 'tasks', label: 'Tasks', icon: 'clipboard-document-list' },
    { key: 'milestones', label: 'Milestones', icon: 'flag' },
    { key: 'activity', label: 'Activity', icon: 'clock' },
  ];

  return (
    <AnimatePresence>
      {projectId && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[2px]"
            onClick={handleBackdropClick}
          />

          <motion.div
            ref={drawerRef}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.05, right: 0.8 }}
            onDragEnd={(_, info) => {
              if (info.offset.x > 150) {
                onClose();
              }
            }}
            className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-[720px] bg-white border-l border-gray-200 shadow-2xl flex flex-col overflow-hidden"
            role="dialog"
            aria-modal="true"
            aria-label={detail ? `Project: ${detail.name}` : 'Project details'}
          >
            {status === 'loading' && !detail && (
              <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-dt-primary/30 border-t-dt-primary rounded-full animate-spin" />
              </div>
            )}

            {detail && (
              <>
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                  <div className="min-w-0">
                    <h2 className="text-[20px] font-bold text-dt-text tracking-tight truncate">{detail.name}</h2>
                    <p className="text-[12px] text-dt-textMuted mt-0.5">
                      {detail.language && <span>{detail.language} • </span>}
                      Last commit {detail.lastCommit || 'never'}
                    </p>
                  </div>
                  <button
                    onClick={onClose}
                    className="w-8 h-8 rounded-lg hover:bg-gray-100 flex items-center justify-center transition-colors shrink-0"
                    aria-label="Close drawer"
                  >
                    <Icon name="x-mark" size={18} className="text-dt-textSecondary" />
                  </button>
                </div>

                <div className="flex items-center gap-1 px-6 py-2 border-b border-gray-100">
                  {tabs.map(tab => (
                    <button
                      key={tab.key}
                      onClick={() => setActiveTab(tab.key)}
                      className={[
                        'relative flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold transition-all duration-200',
                        activeTab === tab.key
                          ? 'text-dt-primary bg-dt-primary/5'
                          : 'text-dt-textSecondary hover:text-dt-text hover:bg-gray-50',
                      ].join(' ')}
                    >
                      <Icon name={tab.icon} size={14} />
                      {tab.label}
                      {tab.key === 'tasks' && detail.tasks.length > 0 && (
                        <span className="ml-1 text-[10px] font-bold text-dt-textMuted tabular-nums">{detail.tasks.length}</span>
                      )}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-5">
                  {activeTab === 'overview' && <OverviewTab detail={detail} />}
                  {activeTab === 'tasks' && (
                    <TaskBoard tasks={detail.tasks} projectId={detail.id} onRefresh={refresh} />
                  )}
                  {activeTab === 'milestones' && <MilestoneTimeline detail={detail} />}
                  {activeTab === 'activity' && <ActivityFeed detail={detail} />}
                </div>
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default ProjectDetailDrawer;
