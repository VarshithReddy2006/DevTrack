import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusResultDialog } from './FocusResultDialog';
import { FocusTodayCompact } from './FocusTodayCompact';
import { FocusHistoryDrawer } from './FocusHistoryDrawer';
import { formatTime } from '../hooks/useFocusSession';
import { focusService } from '../services/focusService';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FocusResultDialog', () => {
  const mockResult = {
    _id: 'session-123',
    userId: 'user-1',
    mode: 'deep_work',
    status: 'completed' as const,
    startedAt: new Date().toISOString(),
    plannedSec: 1500,
    pausedSec: 0,
    xpAwarded: 25,
    xpReason: 'qualified' as const,
  };

  it('renders completed session with duration and qualified XP reward', () => {
    const onClose = vi.fn();
    render(
      <FocusResultDialog
        isOpen={true}
        onClose={onClose}
        result={mockResult}
      />
    );

    expect(screen.getByText('Focus Session Completed')).toBeDefined();
    expect(screen.getByText('25 minutes')).toBeDefined();
    expect(screen.getByText('+25 XP')).toBeDefined();
    expect(screen.getByText('Full XP Credited')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Done & Continue' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders honest feedback when session is under minimum duration', () => {
    render(
      <FocusResultDialog
        isOpen={true}
        onClose={vi.fn()}
        result={{
          ...mockResult,
          xpAwarded: 0,
          xpReason: 'below_min_duration',
        }}
      />
    );

    expect(screen.getByText('+0 XP')).toBeDefined();
    expect(screen.getByText('Minimum Duration Not Met')).toBeDefined();
  });

  it('renders appropriate feedback when daily XP cap is reached', () => {
    render(
      <FocusResultDialog
        isOpen={true}
        onClose={vi.fn()}
        result={{
          ...mockResult,
          xpAwarded: 0,
          xpReason: 'daily_cap_reached',
        }}
      />
    );

    expect(screen.getByText('Daily XP Cap Reached')).toBeDefined();
  });
});

describe('FocusTodayCompact', () => {
  it('displays today minutes, streak, and opens history on click', () => {
    const onOpenHistory = vi.fn();
    render(
      <FocusTodayCompact
        onOpenHistory={onOpenHistory}
        summary={{
          todayMinutes: 75,
          completedSessionsToday: 3,
          currentStreak: 5,
        }}
      />
    );

    expect(screen.getByText("Today's Focus")).toBeDefined();
    expect(screen.getByText('75')).toBeDefined();
    expect(screen.getByText('3 sprints completed')).toBeDefined();
    expect(screen.getByText('5 day streak')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Focus History/i }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });

  it('shows no numbers before the summary arrives, then loads it again when asked to refresh', async () => {
    const load = vi.spyOn(focusService, 'getTodaySummary')
      .mockResolvedValueOnce({ todayMinutes: 0, completedSessionsToday: 0, currentStreak: 0 })
      .mockResolvedValueOnce({ todayMinutes: 25, completedSessionsToday: 1, currentStreak: 1 });

    const view = render(<FocusTodayCompact onOpenHistory={vi.fn()} />);

    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByText(/sprints completed/)).toBeNull();
    expect(await screen.findByText('0 sprints completed')).toBeDefined();

    view.rerender(<FocusTodayCompact onOpenHistory={vi.fn()} refreshKey="session-ended" />);
    expect(await screen.findByText('1 sprints completed')).toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shows an error with a retry when the summary request fails', async () => {
    vi.spyOn(focusService, 'getTodaySummary')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ todayMinutes: 40, completedSessionsToday: 1, currentStreak: 2 });

    render(<FocusTodayCompact onOpenHistory={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load');
    expect(screen.queryByText(/day streak/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('40')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('FocusHistoryDrawer', () => {
  it('shows an error with a retry, not the empty state, when history cannot be loaded', async () => {
    vi.spyOn(focusService, 'getHistory').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);

    render(<FocusHistoryDrawer isOpen={true} onClose={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load');
    expect(screen.queryByText('No sessions recorded yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No sessions recorded yet')).toBeDefined();
  });

  it('hides the XP badge when there is no XP decision and explains stored reasons', async () => {
    const base = { mode: 'deep_work', durationMinutes: 30, startedAt: '2026-01-01T12:00:00.000Z' };
    vi.spyOn(focusService, 'getHistory').mockResolvedValue([
      { ...base, id: 'a', status: 'abandoned', xpAwarded: null },
      { ...base, id: 'b', status: 'completed', xpAwarded: 0, xpReason: 'below_completion_threshold' },
    ]);

    render(<FocusHistoryDrawer isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText('⚠ Under 90% of the planned time was active')).toBeDefined();
    expect(screen.getAllByText(/XP$/).map(node => node.textContent)).toEqual(['+0 XP']);
  });

  it('shows the empty state without fabricated sessions when history is empty', async () => {
    vi.spyOn(focusService, 'getHistory').mockResolvedValue([]);

    render(<FocusHistoryDrawer isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText('No sessions recorded yet')).toBeDefined();
    expect(screen.queryByText('Deep Work')).toBeNull();
    expect(screen.queryByText('DSA Sprint')).toBeNull();
    expect(screen.queryByText('Debugging')).toBeNull();
    expect(screen.queryByText('Learning')).toBeNull();
  });

  it('renders only sessions returned by the history API', async () => {
    vi.spyOn(focusService, 'getHistory').mockResolvedValue([{
      id: 'session-1',
      mode: 'deep_work',
      durationMinutes: 30,
      startedAt: '2026-01-01T12:00:00.000Z',
      status: 'completed',
      xpAwarded: 30,
      xpReason: 'qualified',
    }]);

    render(<FocusHistoryDrawer isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText('Deep Work')).toBeDefined();
    expect(screen.getByText('30 minutes')).toBeDefined();
    expect(screen.queryByText('DSA Sprint')).toBeNull();
    expect(screen.queryByText('Debugging')).toBeNull();
    expect(screen.queryByText('Learning')).toBeNull();
  });

  it('renders drawer with sessions and filter controls when open', () => {
    const onClose = vi.fn();
    render(<FocusHistoryDrawer isOpen={true} onClose={onClose} />);

    expect(screen.getByText('Focus History')).toBeDefined();
    expect(screen.getByText(/Recent sessions & XP breakdown/i)).toBeDefined();

    fireEvent.click(screen.getByLabelText('Close drawer'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not render when closed', () => {
    const { container } = render(<FocusHistoryDrawer isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('useFocusSession helper', () => {
  it('formats seconds into MM:SS correctly', () => {
    expect(formatTime(1500)).toBe('25:00');
    expect(formatTime(65)).toBe('01:05');
    expect(formatTime(9)).toBe('00:09');
    expect(formatTime(0)).toBe('00:00');
  });
});
