import { useEffect, useMemo, useRef, useState } from 'react';
import { MilestoneNode } from './MilestoneNode';
import { roadmapTaskKey, type RoadmapMilestone, type RoadmapTaskState, type RoadmapTaskToggle } from './roadmapTimeline.types';

export interface RoadmapMilestoneTimelineProps {
  /** Stable roadmap identity. A different roadmap resets expansion, errors and pending UI. */
  roadmapId: string;
  milestones: readonly RoadmapMilestone[];
  /** Resolve after persistence succeeds; reject to roll the optimistic change back. */
  onToggleTask: (change: RoadmapTaskToggle) => Promise<void>;
}

function TimelineState({ milestones, onToggleTask }: RoadmapMilestoneTimelineProps) {
  const [taskStates, setTaskStates] = useState<Record<string, RoadmapTaskState>>({});
  const inFlight = useRef(new Set<string>());
  const ordered = useMemo(() => [...milestones].sort((a, b) => a.weekStart - b.weekStart || a.weekEnd - b.weekEnd), [milestones]);

  useEffect(() => {
    const tasks = new Map(milestones.flatMap(milestone => milestone.tasks.map(task => [roadmapTaskKey(milestone.id, task.id), task] as const)));
    const stale = Object.keys(taskStates).filter(key => !taskStates[key].pending
      && (!tasks.has(key) || tasks.get(key)!.completed === taskStates[key].completed));
    if (stale.length) setTaskStates(current => {
      const kept = Object.entries(current).filter(([key, state]) => !stale.includes(key) || state !== taskStates[key]);
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
  }, [milestones, taskStates]);

  async function toggle(change: RoadmapTaskToggle) {
    const milestone = milestones.find(item => item.id === change.milestoneId);
    if (!milestone || milestone.status === 'locked' || !milestone.tasks.some(task => task.id === change.taskId)) return;
    const key = roadmapTaskKey(change.milestoneId, change.taskId);
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setTaskStates(current => ({ ...current, [key]: { completed: change.completed, pending: true } }));
    try {
      await onToggleTask(change);
      setTaskStates(current => ({ ...current, [key]: { completed: change.completed, pending: false } }));
    } catch {
      // Render the latest authoritative prop value on failure, not a captured pre-request value.
      setTaskStates(current => ({ ...current, [key]: {
        completed: change.completed, pending: false, error: 'Couldn’t save this task. Try again.',
      } }));
    } finally { inFlight.current.delete(key); }
  }

  return (
    <section aria-label="Learning roadmap milestones" className="min-w-0 space-y-5">
      <h2 className="text-xl font-bold text-slate-800">Your learning roadmap</h2>
      {ordered.length === 0 ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600">No milestones yet.</p>
      ) : (
        <ol aria-label="Milestone timeline" className="relative space-y-5 before:absolute before:bottom-8 before:left-[18px] before:top-8 before:w-px before:bg-slate-200">
          {ordered.map(milestone => (
            <MilestoneNode key={milestone.id} milestone={milestone} taskStates={taskStates} onToggleTask={toggle} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function RoadmapMilestoneTimeline(props: RoadmapMilestoneTimelineProps) {
  return <TimelineState key={props.roadmapId} {...props} />;
}

export type { RoadmapMilestone, RoadmapTask, RoadmapTaskToggle } from './roadmapTimeline.types';
