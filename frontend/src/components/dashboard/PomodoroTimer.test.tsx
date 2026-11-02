import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PomodoroTimer, focusRemainingSeconds } from './PomodoroTimer';
import { useRuntimeState, type RuntimeState } from '../../hooks/useRuntimeState';
import { activityService } from '../../services/activityService';

vi.mock('../../hooks/useRuntimeState', () => ({ useRuntimeState: vi.fn() }));
vi.mock('../../services/activityService', () => ({ activityService: {
  startFocusSession: vi.fn(), pauseFocusSession: vi.fn(), resumeFocusSession: vi.fn(),
  cancelFocusSession: vi.fn(), stopFocusSession: vi.fn(), heartbeatFocusSession: vi.fn(),
} }));
vi.mock('../../store/missionStore', () => ({ useMissionStore: Object.assign(
  (selector: (state: { getActiveMission: () => null }) => unknown) => selector({ getActiveMission: () => null }),
  { getState: () => ({ getActiveMission: () => null }) },
) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function runtime(sessionContext: RuntimeState['sessionContext']): RuntimeState {
  return { sessionContext } as RuntimeState;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PomodoroTimer /></QueryClientProvider>);
}

it('keeps a paused countdown fixed across refetch and reload, then resumes from active time', async () => {
  const now = Date.parse('2026-11-02T11:02:00Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const paused = { isActive: true, status: 'paused' as const, duration: 25, mode: 'deep_work',
    startedAt: '2026-11-02T10:00:00Z', activeDurationMs: 120_000,
    lastResumedAt: null, problemsThisSession: 0, xpThisSession: 0 };
  vi.mocked(useRuntimeState).mockReturnValue({ data: runtime(paused), loading: false, error: null, refetch: vi.fn() });
  const view = mount();
  expect(await screen.findByText('23:00')).toBeTruthy();
  expect(screen.getByText('Paused')).toBeTruthy();
  vi.spyOn(Date, 'now').mockReturnValue(now + 3_600_000);
  vi.mocked(useRuntimeState).mockReturnValue({ data: runtime({ ...paused }), loading: false, error: null, refetch: vi.fn() });
  view.rerender(<QueryClientProvider client={new QueryClient()}><PomodoroTimer /></QueryClientProvider>);
  expect(await screen.findByText('23:00')).toBeTruthy();
  view.unmount();
  mount();
  expect(await screen.findByText('23:00')).toBeTruthy();
  vi.mocked(activityService.resumeFocusSession).mockResolvedValue({ data: { ...paused, status: 'running', lastResumedAt: new Date(now + 3_600_000).toISOString() } } as never);
  fireEvent.click(screen.getByRole('button', { name: /Resume Focus/ }));
  await waitFor(() => expect(activityService.resumeFocusSession).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByText('In Progress')).toBeTruthy());
  expect(focusRemainingSeconds({ ...paused, status: 'running', lastResumedAt: new Date(now + 3_600_000).toISOString() }, now + 3_720_000)).toBe(21 * 60);
}, 15_000);

it('calls the pause endpoint and leaves the timer paused after a refetch', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-02T10:02:00Z'));
  const running = { isActive: true, status: 'running' as const, duration: 25, mode: 'deep_work',
    startedAt: '2026-11-02T10:00:00Z', activeDurationMs: 0,
    lastResumedAt: '2026-11-02T10:00:00Z', problemsThisSession: 0, xpThisSession: 0 };
  vi.mocked(useRuntimeState).mockReturnValue({ data: runtime(running), loading: false, error: null, refetch: vi.fn() });
  vi.mocked(activityService.pauseFocusSession).mockResolvedValue({ data: { ...running, status: 'paused', activeDurationMs: 120_000, lastResumedAt: null } } as never);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(activityService.pauseFocusSession).toHaveBeenCalledOnce());
  expect(await screen.findByText('Paused')).toBeTruthy();
  expect(await screen.findByText('23:00')).toBeTruthy();
});
