// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReducedMotionProvider } from '../../../design-system/motion/ReducedMotion';
import { RoadmapMilestoneTimeline, type RoadmapMilestone, type RoadmapMilestoneTimelineProps, type RoadmapTaskToggle } from '../components/RoadmapMilestoneTimeline';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (media: string) => ({
    matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  }) });
});
afterEach(cleanup);

function milestones(): RoadmapMilestone[] {
  return [
    { id: 'redis', title: 'Redis infrastructure', objective: 'Build a replicated cache and measure failover.', weekStart: 3, weekEnd: 4, estimatedHours: 12, status: 'active',
      tasks: [{ id: 'sentinel', title: 'Configure Redis Sentinel', completed: false, href: '/projects/cache-topology' }, { id: 'graphs', title: 'Solve three graph problems', completed: false, href: 'https://leetcode.com/tag/graph/' }] },
    { id: 'deploy', title: 'Deploy the system', objective: 'Measure reliability under load.', weekStart: 5, weekEnd: 6, estimatedHours: 8, status: 'locked',
      tasks: [{ id: 'deploy-task', title: 'Deploy the project', completed: false }] },
    { id: 'basics', title: 'Backend foundations', objective: 'Build and test the service.', weekStart: 1, weekEnd: 2, estimatedHours: 10, status: 'completed',
      tasks: [{ id: 'api', title: 'Build the API', completed: true }, { id: 'tests', title: 'Write service tests', completed: true }] },
  ];
}
const mutation = () => vi.fn<(change: RoadmapTaskToggle) => Promise<void>>().mockResolvedValue(undefined);
const ui = (props: RoadmapMilestoneTimelineProps) => <ReducedMotionProvider forceReducedMotion><RoadmapMilestoneTimeline {...props} /></ReducedMotionProvider>;
function mount(data = milestones(), onToggleTask = mutation()) {
  const props = { roadmapId: 'roadmap-a', milestones: data, onToggleTask };
  return { ...render(ui(props)), props, onToggleTask };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const activeInput = () => screen.getByRole('checkbox', { name: 'Configure Redis Sentinel' });
const progress = () => screen.getByRole('progressbar', { name: 'Redis infrastructure progress' });
function changed(data: readonly RoadmapMilestone[], taskId: string, completed: boolean) {
  return data.map(m => ({ ...m, tasks: m.tasks.map(t => t.id === taskId ? { ...t, completed } : t) }));
}

it('orders milestone weeks without mutating the caller data and writes out every status', () => {
  const data = milestones();
  const order = data.map(item => item.id);
  Object.freeze(data);
  mount(data);
  const headings = within(screen.getByRole('list', { name: 'Milestone timeline' })).getAllByRole('heading', { level: 3 });
  expect(headings.map(h => h.textContent)).toEqual([
    expect.stringContaining('Backend foundations'), expect.stringContaining('Redis infrastructure'), expect.stringContaining('Deploy the system'),
  ]);
  expect(data.map(item => item.id)).toEqual(order);
  for (const label of ['Weeks 1–2', 'Weeks 3–4', 'Weeks 5–6', 'Completed', 'Active', 'Locked', '12 hours']) expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByText('Redis infrastructure').closest('li')).toHaveAttribute('aria-current', 'step');
});

it('expands only the active milestone by default and exposes objective and task links', () => {
  mount();
  expect(screen.getByRole('button', { name: /Redis infrastructure/ })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: /Backend foundations/ })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: /Deploy the system/ })).toHaveAttribute('aria-expanded', 'false');
  expect(within(screen.getByRole('list', { name: 'Milestone timeline' })).getAllByRole('region')).toHaveLength(1);
  expect(screen.getByText('Build a replicated cache and measure failover.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open practice: Configure Redis Sentinel' })).toHaveAttribute('href', '/projects/cache-topology');
  const external = screen.getByRole('link', { name: /Open practice: Solve three graph problems/ });
  expect(external).toHaveAttribute('target', '_blank'); expect(external).toHaveAttribute('rel', 'noopener noreferrer');
});

it('collapses inaccessible content immediately while its exit animation completes', async () => {
  mount(); const button = screen.getByRole('button', { name: /Redis infrastructure/ });
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById(button.getAttribute('aria-controls')!)).toHaveAttribute('inert');
  expect(screen.queryByRole('checkbox', { name: 'Configure Redis Sentinel' })).not.toBeInTheDocument();
  fireEvent.click(button);
  await waitFor(() => expect(activeInput()).toBeInTheDocument());
  expect(button).toHaveAttribute('aria-expanded', 'true');
});

it('calculates progress including completed and empty checklists without NaN', () => {
  const data = milestones(); data[0].tasks = [];
  mount(data);
  expect(progress()).toHaveAttribute('aria-valuenow', '0');
  expect(screen.getByRole('progressbar', { name: 'Backend foundations progress' })).toHaveAttribute('aria-valuenow', '100');
  expect(screen.getByText('No tasks in this milestone yet.')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('renders the empty roadmap without fabricated milestones', () => {
  mount([]);
  expect(screen.getByText('No milestones yet.')).toBeInTheDocument();
  expect(screen.queryByRole('list')).not.toBeInTheDocument();
});

it('updates the checkbox and progress optimistically, then retains the confirmed result', async () => {
  const request = deferred(); const onToggle = mutation().mockReturnValueOnce(request.promise);
  mount(milestones(), onToggle);
  fireEvent.click(activeInput());
  expect(onToggle).toHaveBeenCalledExactlyOnceWith({ milestoneId: 'redis', taskId: 'sentinel', completed: true });
  expect(activeInput()).toBeChecked(); expect(activeInput()).toHaveAttribute('aria-disabled', 'true');
  expect(progress()).toHaveAttribute('aria-valuenow', '50');
  expect(screen.getByRole('status')).toHaveTextContent('Saving task');
  await act(async () => request.resolve());
  expect(activeInput()).toBeChecked(); expect(activeInput()).toHaveAttribute('aria-disabled', 'false');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('fences repeated clicks while a task is pending', async () => {
  const request = deferred(); const onToggle = mutation().mockReturnValueOnce(request.promise);
  mount(milestones(), onToggle);
  act(() => { fireEvent.click(activeInput()); fireEvent.click(activeInput()); fireEvent.click(activeInput()); });
  expect(onToggle).toHaveBeenCalledTimes(1); expect(activeInput()).toBeChecked();
  await act(async () => request.resolve());
});

it('rolls back a rejected mutation and supports a successful retry without showing server internals', async () => {
  const request = deferred(); const onToggle = mutation().mockReturnValueOnce(request.promise);
  mount(milestones(), onToggle); fireEvent.click(activeInput());
  await act(async () => request.reject(new Error('private backend detail')));
  expect(activeInput()).not.toBeChecked(); expect(progress()).toHaveAttribute('aria-valuenow', '0');
  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t save this task. Try again.');
  expect(screen.queryByText('private backend detail')).not.toBeInTheDocument();
  fireEvent.click(activeInput());
  await waitFor(() => expect(activeInput()).toHaveAttribute('aria-disabled', 'false'));
  expect(onToggle).toHaveBeenCalledTimes(2); expect(activeInput()).toBeChecked();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('handles independent mutations completing out of order', async () => {
  const first = deferred(); const second = deferred();
  const onToggle = mutation().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  mount(milestones(), onToggle);
  fireEvent.click(activeInput()); fireEvent.click(screen.getByRole('checkbox', { name: 'Solve three graph problems' }));
  expect(progress()).toHaveAttribute('aria-valuenow', '100');
  await act(async () => second.resolve());
  await act(async () => first.reject(new Error('failed')));
  expect(activeInput()).not.toBeChecked(); expect(screen.getByRole('checkbox', { name: 'Solve three graph problems' })).toBeChecked();
  expect(progress()).toHaveAttribute('aria-valuenow', '50');
});

it('separates identical task IDs belonging to different milestones', async () => {
  const data = milestones().slice(0, 1);
  data.push({ ...data[0], id: 'other', title: 'Other milestone', weekStart: 7, weekEnd: 8 });
  const { onToggleTask } = mount(data);
  const inputs = screen.getAllByRole('checkbox', { name: 'Configure Redis Sentinel' });
  fireEvent.click(inputs[0]);
  await waitFor(() => expect(inputs[0]).toHaveAttribute('aria-disabled', 'false'));
  expect(inputs[0]).toBeChecked(); expect(inputs[1]).not.toBeChecked();
  expect(onToggleTask).toHaveBeenCalledExactlyOnceWith({ milestoneId: 'redis', taskId: 'sentinel', completed: true });
});

it('accepts server acknowledgements and later external completion changes', async () => {
  const data = milestones(); const { props, rerender } = mount(data);
  fireEvent.click(activeInput());
  await waitFor(() => expect(activeInput()).toHaveAttribute('aria-disabled', 'false'));
  rerender(ui({ ...props, milestones: changed(data, 'sentinel', true) }));
  expect(activeInput()).toBeChecked();
  rerender(ui({ ...props, milestones: changed(data, 'sentinel', false) }));
  expect(activeInput()).not.toBeChecked();
});

it('preserves current server changes when another optimistic task fails', async () => {
  const data = milestones(); const request = deferred();
  const { props, rerender } = mount(data, mutation().mockReturnValueOnce(request.promise));
  fireEvent.click(activeInput());
  rerender(ui({ ...props, milestones: changed(data, 'graphs', true) }));
  expect(progress()).toHaveAttribute('aria-valuenow', '100');
  await act(async () => request.reject(new Error('failed')));
  expect(activeInput()).not.toBeChecked(); expect(screen.getByRole('checkbox', { name: 'Solve three graph problems' })).toBeChecked();
  expect(progress()).toHaveAttribute('aria-valuenow', '50');
});

it('preserves a pending task if a same-roadmap refresh temporarily removes and restores it', async () => {
  const data = milestones(); const request = deferred();
  const { props, rerender, onToggleTask } = mount(data, mutation().mockReturnValueOnce(request.promise));
  fireEvent.click(activeInput());
  rerender(ui({ ...props, milestones: data.map(m => ({ ...m, tasks: m.tasks.filter(t => t.id !== 'sentinel') })) }));
  expect(screen.queryByRole('checkbox', { name: 'Configure Redis Sentinel' })).not.toBeInTheDocument();
  rerender(ui({ ...props, milestones: data }));
  expect(activeInput()).toBeChecked(); expect(activeInput()).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(activeInput()); expect(onToggleTask).toHaveBeenCalledTimes(1);
  await act(async () => request.reject(new Error('failed')));
  expect(activeInput()).not.toBeChecked();
});

it('resets pending state for a new roadmap and ignores late failures from the previous one', async () => {
  const old = deferred(); const current = deferred();
  const onToggle = mutation().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const { props, rerender } = mount(milestones(), onToggle);
  fireEvent.click(activeInput());
  rerender(ui({ ...props, roadmapId: 'roadmap-b', milestones: milestones() }));
  expect(activeInput()).not.toBeChecked(); expect(activeInput()).toHaveAttribute('aria-disabled', 'false');
  fireEvent.click(activeInput()); expect(onToggle).toHaveBeenCalledTimes(2);
  await act(async () => current.resolve()); await act(async () => old.reject(new Error('old failure')));
  expect(activeInput()).toBeChecked(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('opens a newly active milestone but respects a user collapse on ordinary rerenders', () => {
  const data = milestones(); const { props, rerender } = mount(data);
  const button = screen.getByRole('button', { name: /Deploy the system/ });
  const unlocked = data.map(m => m.id === 'deploy' ? { ...m, status: 'active' as const } : m);
  rerender(ui({ ...props, milestones: unlocked }));
  expect(button).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(button);
  rerender(ui({ ...props, milestones: [...unlocked] }));
  expect(button).toHaveAttribute('aria-expanded', 'false');
});

it('never toggles locked tasks, even when their details are expanded', async () => {
  const { onToggleTask } = mount();
  fireEvent.click(screen.getByRole('button', { name: /Deploy the system/ }));
  const input = await screen.findByRole('checkbox', { name: 'Deploy the project' });
  expect(input).toBeDisabled(); fireEvent.click(input); expect(onToggleTask).not.toHaveBeenCalled();
});

it('shows checklist completion immediately without unlocking future milestones locally', async () => {
  const data = changed(milestones(), 'graphs', true); mount(data);
  fireEvent.click(activeInput());
  await waitFor(() => expect(activeInput()).toHaveAttribute('aria-disabled', 'false'));
  expect(progress()).toHaveAttribute('aria-valuenow', '100');
  expect(screen.getByText('Redis infrastructure').closest('li')).toHaveAttribute('data-status', 'completed');
  expect(screen.getByText('Deploy the system').closest('li')).toHaveAttribute('data-status', 'locked');
  fireEvent.click(activeInput());
  await waitFor(() => expect(progress()).toHaveAttribute('aria-valuenow', '50'));
  expect(screen.getByText('Redis infrastructure').closest('li')).toHaveAttribute('aria-current', 'step');
});

it('reports a save failure even after the user collapses the milestone', async () => {
  const request = deferred(); mount(milestones(), mutation().mockReturnValueOnce(request.promise));
  fireEvent.click(activeInput()); fireEvent.click(screen.getByRole('button', { name: /Redis infrastructure/ }));
  await act(async () => request.reject(new Error('failed')));
  expect(screen.getByRole('alert')).toHaveTextContent('Expand this milestone to retry.');
});

it.each(['javascript:alert(1)', 'data:text/html,x', '//evil.test/x', '/\\evil.test/x', 'https://user:password@example.com/', 'https://example.com/\npath'])('does not render an unsafe practice link: %s', href => {
  const data = milestones().slice(0, 1); data[0].tasks = [{ id: 'safe', title: 'Practice', completed: false, href }];
  mount(data); expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('keeps accordion relationships unique when two timelines are rendered together', () => {
  const props = { roadmapId: 'roadmap-a', milestones: milestones(), onToggleTask: mutation() };
  render(<>{ui(props)}{ui({ ...props, roadmapId: 'roadmap-b' })}</>);
  const buttons = screen.getAllByRole('button', { name: /Redis infrastructure/ });
  const ids = buttons.map(button => button.getAttribute('aria-controls'));
  expect(new Set(ids).size).toBe(2);
  for (const button of buttons) expect(document.getElementById(button.getAttribute('aria-controls')!)).toHaveAttribute('aria-labelledby', button.id);
});

it('respects the existing reduced-motion provider by suppressing the active pulse', () => {
  const { container } = mount();
  expect(container.querySelector('[class*="animate-pulse"]')).toBeNull();
});
