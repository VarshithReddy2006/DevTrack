import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FocusResultDialog } from './FocusResultDialog';
import { FocusTodayCompact } from './FocusTodayCompact';
import { FocusHistoryDrawer } from './FocusHistoryDrawer';
import { formatTime } from '../hooks/useFocusSession';

afterEach(() => {
  cleanup();
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
          targetMinutes: 120,
          completedSessionsToday: 3,
          currentStreak: 5,
        }}
      />
    );

    expect(screen.getByText("Today's Focus")).toBeDefined();
    expect(screen.getByText('75')).toBeDefined();
    expect(screen.getByText('Target: 120m')).toBeDefined();
    expect(screen.getByText('3 sprints completed')).toBeDefined();
    expect(screen.getByText('5 day streak')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Focus History/i }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });
});

describe('FocusHistoryDrawer', () => {
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
