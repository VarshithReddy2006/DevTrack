// ============================================================================
// TaskDetailDrawer.tsx — Side panel for editing a single task
// ============================================================================

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Icon, type IconName } from '../../../components/shared/Icon';
import { deleteProjectTask, updateProjectTask } from '../../../services/projectsService';
import type { ProjectTaskVM } from '../../../types/vm.types';
import { useDialogFocus } from '../../../components/ui/useDialogFocus';

interface TaskDetailDrawerProps {
  task: ProjectTaskVM | null;
  projectId: string;
  onClose: () => void;
  onUpdated: () => void;
}

const STATUS_OPTIONS: { value: string; label: string; color: string; icon: IconName }[] = [
  { value: 'todo', label: 'To Do', color: 'text-gray-500', icon: 'circle' },
  { value: 'in_progress', label: 'In Progress', color: 'text-blue-600', icon: 'clock' },
  { value: 'review', label: 'Review', color: 'text-amber-600', icon: 'eye' },
  { value: 'done', label: 'Done', color: 'text-emerald-600', icon: 'check-circle' },
];

const PRIORITY_OPTIONS: { value: string; label: string; color: string }[] = [
  { value: 'critical', label: 'Critical', color: 'text-red-600' },
  { value: 'high', label: 'High', color: 'text-orange-600' },
  { value: 'medium', label: 'Medium', color: 'text-amber-600' },
  { value: 'low', label: 'Low', color: 'text-gray-500' },
];

export const TaskDetailDrawer: React.FC<TaskDetailDrawerProps> = ({
  task,
  projectId,
  onClose,
  onUpdated,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('todo');
  const [priority, setPriority] = useState('medium');
  const [labels, setLabels] = useState<string[]>([]);
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(onClose);
  const titleId = React.useId();

  // Populate form when task changes
  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description || '');
      setStatus(task.statusLabel.toLowerCase().replace(/\s+/g, '_'));
      setPriority(task.priorityLabel.toLowerCase());
      setLabels([...task.labels]);
      setDirty(false);
    }
  }, [task]);

  const handleSave = async () => {
    if (!task || saving) return;
    setSaving(true);
    try {
      await updateProjectTask(projectId, task.id, {
        title: title.trim(),
        description: description.trim(),
        status: status as any,
        priority: priority as any,
        labels,
      });
      setDirty(false);
      onUpdated();
      onClose();
    } catch {
      // Error handled
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!task || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteProjectTask(projectId, task.id);
      onUpdated();
      onClose();
    } catch {
      setDeleteError('Unable to delete this task. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  const handleAddLabel = () => {
    const tag = newLabel.trim();
    if (tag && !labels.includes(tag)) {
      setLabels([...labels, tag]);
      setNewLabel('');
      setDirty(true);
    }
  };

  const handleRemoveLabel = (label: string) => {
    setLabels(labels.filter(l => l !== label));
    setDirty(true);
  };

  const markDirty = () => setDirty(true);

  return (
    <AnimatePresence>
      {task && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[60] bg-black/15"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            ref={dialogRef}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 32, stiffness: 350 }}
            className="fixed right-0 top-0 bottom-0 z-[70] w-full max-w-[480px] bg-white border-l border-gray-200 shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
              <h3 id={titleId} className="text-[15px] font-bold text-dt-text">Edit Task</h3>
              <div className="flex items-center gap-2">
                {dirty && (
                  <span className="text-[10px] font-medium text-amber-500">Unsaved</span>
                )}
                <button
                  onClick={onClose}
                  className="w-7 h-7 rounded-lg hover:bg-gray-100 flex items-center justify-center transition-colors"
                  aria-label="Close"
                >
                  <Icon name="x-mark" size={16} className="text-dt-textSecondary" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
              {/* Title */}
              <div>
                <label className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider mb-1.5 block">Title</label>
                <input
                  data-dialog-initial-focus
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); markDirty(); }}
                  className="w-full text-[15px] font-semibold text-dt-text bg-transparent border border-gray-200 rounded-xl px-3.5 py-2.5 outline-none focus:border-dt-primary/40 transition-colors"
                  placeholder="Task title..."
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider mb-1.5 block">Description</label>
                <textarea
                  value={description}
                  onChange={(e) => { setDescription(e.target.value); markDirty(); }}
                  className="w-full text-[13px] text-dt-textSecondary bg-transparent border border-gray-200 rounded-xl px-3.5 py-2.5 outline-none focus:border-dt-primary/40 transition-colors resize-none"
                  rows={4}
                  placeholder="Add a description..."
                />
              </div>

              {/* Status & Priority row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider mb-1.5 block">Status</label>
                  <div className="flex flex-col gap-1">
                    {STATUS_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => { setStatus(opt.value); markDirty(); }}
                        className={[
                          'flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] font-semibold transition-all',
                          status === opt.value
                            ? 'bg-gray-100 text-dt-text'
                            : 'text-dt-textSecondary hover:bg-gray-50',
                        ].join(' ')}
                      >
                        <Icon name={opt.icon} size={13} className={opt.color} />
                        {opt.label}
                        {status === opt.value && (
                          <Icon name="check" size={12} className="ml-auto text-dt-primary" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider mb-1.5 block">Priority</label>
                  <div className="flex flex-col gap-1">
                    {PRIORITY_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => { setPriority(opt.value); markDirty(); }}
                        className={[
                          'flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] font-semibold transition-all',
                          priority === opt.value
                            ? 'bg-gray-100 text-dt-text'
                            : 'text-dt-textSecondary hover:bg-gray-50',
                        ].join(' ')}
                      >
                        <span className={`w-2 h-2 rounded-full ${
                          opt.value === 'critical' ? 'bg-red-500' :
                          opt.value === 'high' ? 'bg-orange-500' :
                          opt.value === 'medium' ? 'bg-amber-500' :
                          'bg-gray-400'
                        }`} />
                        {opt.label}
                        {priority === opt.value && (
                          <Icon name="check" size={12} className="ml-auto text-dt-primary" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Labels */}
              <div>
                <label className="text-[10px] font-bold text-dt-textMuted uppercase tracking-wider mb-1.5 block">Labels</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {labels.map(label => (
                    <span key={label} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-gray-100 text-[11px] font-medium text-dt-textSecondary">
                      {label}
                      <button
                        onClick={() => handleRemoveLabel(label)}
                        aria-label={`Remove ${label} label`}
                        className="text-dt-textMuted hover:text-red-500 transition-colors"
                      >
                        <Icon name="x-mark" size={10} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddLabel(); } }}
                    className="flex-1 text-[12px] text-dt-text bg-transparent border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-dt-primary/40 transition-colors"
                    placeholder="Add label..."
                  />
                  <button
                    onClick={handleAddLabel}
                    disabled={!newLabel.trim()}
                    className="px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-[11px] font-semibold text-dt-textSecondary disabled:opacity-40 transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-3.5 border-t border-gray-100">
              {deleteError && <p role="alert" className="text-xs text-red-600 mb-3">{deleteError}</p>}
              {confirmDelete ? (
                <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-xs font-medium text-red-700">Delete this task permanently?</p>
                  <div className="flex justify-end gap-2 mt-2">
                    <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-dt-textSecondary hover:bg-white">Keep Task</button>
                    <button type="button" onClick={handleDelete} disabled={deleting} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50">{deleting ? 'Deleting…' : 'Confirm Delete'}</button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmDelete(true)} disabled={saving || deleting} className="mb-3 px-3 py-2 rounded-lg text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40">Delete Task</button>
              )}
              <div className="flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg text-[12px] font-semibold text-dt-textSecondary hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !dirty || !title.trim()}
                className="px-5 py-2 rounded-lg text-[12px] font-semibold text-white bg-dt-primary hover:bg-dt-primary/90 disabled:opacity-40 transition-colors"
              >
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default TaskDetailDrawer;
