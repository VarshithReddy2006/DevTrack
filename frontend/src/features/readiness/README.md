# Roadmap milestone timeline

`components/RoadmapMilestoneTimeline.tsx` renders an ordered, connected learning
timeline using the existing Framer Motion durations/easing and reduced-motion
support. It accepts a frontend view model and an async persistence callback:

```tsx
import { RoadmapMilestoneTimeline, type RoadmapMilestone } from './components/RoadmapMilestoneTimeline';

// Map actual API data into RoadmapMilestone[] at the owning page/query boundary.
<RoadmapMilestoneTimeline
  roadmapId={roadmap.id}
  milestones={milestones}
  onToggleTask={async change => {
    await taskMutation.mutateAsync(change);
    // Refresh/invalidate the owning query after persistence succeeds.
  }}
/>
```

## View model and behavior

- A milestone has `id`, `title`, `objective`, `weekStart`, `weekEnd`,
  `estimatedHours`, `status` (`completed`, `active`, `locked`) and `tasks`.
  Each task has `id`, `title`, `completed` and an optional practice `href`.
  Supply finite positive week numbers, an end week at or after the start, and
  nonnegative estimated hours. Milestones sort by start/end week without mutating
  the input. Single-week and multi-week ranges are both supported.
- Use immutable props, unique stable milestone IDs and unique task IDs within
  each milestone. The `roadmapId` must identify the current user's roadmap.
  Changing that identity resets expansion, errors and pending UI; late responses
  from the old instance cannot change the new roadmap.
- Active milestones expand initially and when the server changes a milestone to
  active. Ordinary rerenders preserve a user's collapse choice. Completed and
  locked milestones can be expanded for inspection. Locked task checkboxes cannot
  mutate; links can still open reference/practice material.
- Progress is the rounded percentage of completed tasks, including optimistic
  changes. Empty checklists show zero progress and an explicit empty state.
  A fully checked, unlocked milestone displays completed; unchecking a task
  reopens it visually. Future locked milestones remain locked until the caller
  supplies updated authoritative statuses.
- `onToggleTask({ milestoneId, taskId, completed })` must resolve on successful
  persistence and reject on failure. Each task accepts only one in-flight change;
  different tasks may save independently. Confirmed changes remain visible while
  awaiting matching server props. Once props acknowledge a change, later external
  changes are authoritative. Failed changes roll back to the latest prop value,
  with a generic retryable error. No error details from the backend are rendered.
- Native buttons/labels/checkboxes, ARIA expansion/progress state, unique panel IDs
  and inert collapsed panels support keyboard and assistive access. Pending
  checkboxes use `aria-disabled` plus a synchronous mutation fence, preserving
  focus while preventing duplicate saves. Errors remain visible if a panel is
  collapsed during the request.
- Practice links allow same-origin absolute paths and credential-free HTTP(S)
  URLs. Protocol-relative, script/data, backslash and control/space-containing
  URLs are omitted. External links explicitly announce a new tab and use
  `noopener noreferrer`.

## Integration boundary

Current main has the legacy skill-based roadmap response, not the persisted
CareerRoadmap/task-completion contract requested by backend issue #441. This
change supplies the reusable component and callback boundary for #458. It does
not invent endpoint URLs, persist completion only in browser storage, show fixture
milestones to real users, or replace the existing roadmap page with an unwired UI.
Mount it from the owning page once real milestone data and task mutations are
available; adapt those contracts there. Backend ownership, completion verification
and progression/unlocking rules remain server responsibilities.

## Validation

From `frontend/`:

```powershell
npm run build
npm exec eslint src/features/readiness/components/RoadmapMilestoneTimeline.tsx src/features/readiness/components/MilestoneNode.tsx src/features/readiness/components/roadmapTimeline.types.ts src/features/readiness/__tests__/RoadmapMilestoneTimeline.test.tsx
npm exec vitest run src/features/readiness/__tests__/RoadmapMilestoneTimeline.test.tsx
```

Unit tests use fixture data and persistence promises, covering ordering, ARIA
relationships, progress, optimistic concurrency, rollback/retry, server updates,
roadmap identity changes, locks and link safety. Real-browser fixture checks are
needed for layout, native keyboard interactions, focus and motion. They do not
establish live backend integration, other browser engines or screen-reader behavior.
