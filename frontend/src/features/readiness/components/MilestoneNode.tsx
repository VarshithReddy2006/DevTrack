import { useEffect, useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion as useSystemReducedMotion } from 'framer-motion';
import { Check, ChevronDown, CircleDot, Clock, ExternalLink, Lock } from 'lucide-react';
import { useReducedMotion } from '../../../design-system/motion/ReducedMotion';
import { easePremium, motionDurations } from '../../../lib/motion';
import { roadmapTaskKey, type RoadmapMilestone, type RoadmapTaskState, type RoadmapTaskToggle } from './roadmapTimeline.types';

interface Props {
  milestone: RoadmapMilestone;
  taskStates: Readonly<Record<string, RoadmapTaskState>>;
  onToggleTask: (change: RoadmapTaskToggle) => Promise<void>;
}

function practiceHref(value?: string): string | null {
  if (!value || value.includes('\\') || Array.from(value).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

const TASK_KIND_META: Record<'learn' | 'build' | 'practice' | 'verify', { label: string; className: string }> = {
  learn: { label: 'Learn', className: 'border-indigo-200 bg-indigo-50 text-indigo-700' },
  build: { label: 'Build', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  practice: { label: 'DSA', className: 'border-violet-200 bg-violet-50 text-violet-700' },
  verify: { label: 'Verify', className: 'border-amber-200 bg-amber-50 text-amber-800' },
};

export function MilestoneNode({ milestone, taskStates, onToggleTask }: Props) {
  const [expanded, setExpanded] = useState(milestone.status === 'active');
  const panelId = useId();
  const headingId = useId();
  const systemReduced = useSystemReducedMotion();
  const { prefersReducedMotion } = useReducedMotion();
  const reduced = prefersReducedMotion || systemReduced;
  useEffect(() => { if (milestone.status === 'active') setExpanded(true); }, [milestone.status]);

  const tasks = milestone.tasks.map(task => {
    const state = taskStates[roadmapTaskKey(milestone.id, task.id)];
    return { ...task, completed: state && !state.error ? state.completed : task.completed, pending: state?.pending ?? false, error: state?.error };
  });
  const done = tasks.filter(task => task.completed).length;
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  const status = milestone.status === 'locked' || tasks.length === 0 ? milestone.status
    : done === tasks.length ? 'completed' : 'active';
  const locked = milestone.status === 'locked';
  const label = { active: 'Active', completed: 'Completed', locked: 'Locked' }[status];
  const Icon = status === 'completed' ? Check : locked ? Lock : CircleDot;
  const weeks = milestone.weekStart === milestone.weekEnd ? `Week ${milestone.weekStart}` : `Weeks ${milestone.weekStart}–${milestone.weekEnd}`;

  return (
    <li aria-current={status === 'active' ? 'step' : undefined} className="relative min-w-0 pl-12" data-status={status}>
      <span aria-hidden="true" className={`absolute left-0 top-6 flex size-9 items-center justify-center rounded-full border-4 border-white shadow-sm ${
        status === 'completed' ? 'bg-emerald-100 text-emerald-700' : locked ? 'bg-slate-100 text-slate-500' : 'bg-blue-100 text-blue-700 ring-2 ring-blue-400'
      }`}>
        {status === 'active' && !reduced && <span className="absolute inset-0 rounded-full ring-2 ring-blue-300 motion-safe:animate-pulse" />}
        <Icon size={16} />
      </span>
      <div className={`min-w-0 rounded-2xl border bg-white shadow-sm ${status === 'active' ? 'border-blue-300 ring-1 ring-blue-100' : 'border-slate-200'}`}>
        <h3>
          <button id={headingId} type="button" aria-expanded={expanded} aria-controls={panelId}
            onClick={() => setExpanded(value => !value)}
            className="flex w-full min-w-0 items-start gap-3 rounded-2xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:p-5">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold">
                <span className="text-slate-500">
                  {weeks}{milestone.dateRangeLabel ? ` · ${milestone.dateRangeLabel}` : ''}
                </span>
                <span className={status === 'completed' ? 'text-emerald-700' : locked ? 'text-slate-500' : 'text-blue-700'}>{label}</span>
                {milestone.paceStatus && status !== 'locked' && (
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                    milestone.paceStatus === 'behind_pace'
                      ? 'border-amber-200 bg-amber-50 text-amber-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  }`}>
                    {milestone.paceStatus === 'behind_pace' ? 'Behind Pace' : 'On Track'}
                  </span>
                )}
              </span>
              <span className="mt-1 block break-words text-base font-bold text-slate-800 [overflow-wrap:anywhere]">{milestone.title}</span>
            </span>
            <ChevronDown aria-hidden="true" size={18} className={`mt-1 shrink-0 text-slate-500 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} />
          </button>
        </h3>
        <div className="px-4 pb-4 sm:px-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
            <span>{done} of {tasks.length} tasks completed</span>
            <span className="inline-flex items-center gap-1"><Clock aria-hidden="true" size={12} />{milestone.estimatedHours} {milestone.estimatedHours === 1 ? 'hour' : 'hours'}</span>
          </div>
          <div role="progressbar" aria-label={`${milestone.title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
            aria-valuetext={`${done} of ${tasks.length} tasks completed`} className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className={`h-full rounded-full transition-[width] motion-reduce:transition-none ${status === 'completed' ? 'bg-emerald-500' : locked ? 'bg-slate-400' : 'bg-blue-500'}`} style={{ width: `${percent}%` }} />
          </div>
          {!expanded && tasks.some(task => task.error) && <p role="alert" className="mt-3 text-sm text-rose-700">A task change couldn’t be saved. Expand this milestone to retry.</p>}
        </div>
        <div id={panelId} role="region" aria-labelledby={headingId} aria-hidden={!expanded} inert={!expanded}>
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div key="details" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reduced ? 0 : motionDurations.base, ease: easePremium }} className="overflow-hidden">
                <div className="space-y-4 border-t border-slate-100 p-4 sm:p-5">
                  <p className="break-words text-sm leading-relaxed text-slate-600 [overflow-wrap:anywhere]">{milestone.objective}</p>
                  {locked && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
                      <span className="font-semibold text-slate-700">Read-only preview:</span>{' '}
                      These tasks unlock once prior milestones are completed.
                      {milestone.skills && milestone.skills.length > 0 && (
                        <span className="ml-1.5 text-slate-500">
                          Upcoming skills: {milestone.skills.join(', ')}.
                        </span>
                      )}
                    </div>
                  )}
                  {tasks.length === 0 ? <p className="text-sm text-slate-500">No tasks in this milestone yet.</p> : (
                    <ul aria-label={`${milestone.title} tasks`} className="space-y-3">
                      {tasks.map(task => {
                        const href = practiceHref(task.href);
                        const kindMeta = task.kind ? TASK_KIND_META[task.kind] : null;
                        return (
                          <li key={task.id} aria-busy={task.pending || undefined} className="min-w-0 rounded-xl bg-slate-50 p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <label className={`flex min-h-6 min-w-0 flex-1 items-start gap-3 text-sm ${locked || task.pending ? 'cursor-default' : 'cursor-pointer'}`}>
                                <input type="checkbox" checked={task.completed} disabled={locked} aria-disabled={locked || task.pending}
                                  onChange={event => { if (!task.pending && !locked) void onToggleTask({ milestoneId: milestone.id, taskId: task.id, completed: event.target.checked }); }}
                                  className="mt-0.5 size-5 shrink-0 rounded border-slate-300 accent-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50" />
                                <span className={`min-w-0 break-words [overflow-wrap:anywhere] ${task.completed ? 'text-slate-500 line-through' : 'text-slate-800'}`}>{task.title}</span>
                              </label>
                              {kindMeta && (
                                <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${kindMeta.className}`}>
                                  {kindMeta.label}
                                </span>
                              )}
                            </div>
                            {href && <a href={href} target={href.startsWith('/') ? undefined : '_blank'} rel={href.startsWith('/') ? undefined : 'noopener noreferrer'}
                              aria-label={`Open practice: ${task.title}${href.startsWith('/') ? '' : ' (opens in a new tab)'}`}
                              className="ml-8 mt-2 inline-flex items-center gap-1 rounded text-xs font-semibold text-blue-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
                              {task.actionLabel ?? 'Open practice'}<ExternalLink aria-hidden="true" size={12} />
                            </a>}
                            {task.pending && <p role="status" className="ml-8 mt-2 text-xs text-slate-500">Saving task…</p>}
                            {task.error && <p role="alert" className="ml-8 mt-2 text-xs text-rose-700">{task.error}</p>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </li>
  );
}
