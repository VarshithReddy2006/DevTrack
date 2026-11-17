import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUserStore } from '../../../store/userStore';
import { ConnectionRecoveryBanner, RecoveryOverlay, secondsUntil } from '../RecoveryOverlay';

const sse = vi.hoisted(() => ({
  state: {
    connectionStatus: 'connected',
    nextReconnectAt: null as number | null,
    eventHistory: [] as unknown[],
  },
  reconnectNow: vi.fn(),
}));
vi.mock('../../../hooks/useSse', () => ({
  useSse: () => sse.state,
  reconnectNow: sse.reconnectNow,
}));
// Exit animations do not finish under fake timers, so render plain elements.
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: new Proxy({}, {
    get: (_t, tag: string) =>
      ({ children, initial, animate, exit, transition, ...rest }: Record<string, unknown>) => {
        void initial; void animate; void exit; void transition;
        const Tag = tag as 'div';
        return <Tag {...(rest as object)}>{children as ReactNode}</Tag>;
      },
  }),
}));

const queryClient = new QueryClient();
const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

function ui() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionRecoveryBanner />
    </QueryClientProvider>
  );
}

function setSse(connectionStatus: string, nextReconnectAt: number | null = null) {
  sse.state.connectionStatus = connectionStatus;
  sse.state.nextReconnectAt = nextReconnectAt;
}

describe('ConnectionRecoveryBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    useUserStore.setState({ isAuthenticated: true });
    setSse('connected');
    sse.state.eventHistory = [];
    sse.reconnectNow.mockClear();
    invalidate.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('keeps an empty polite live region and no banner while connected', () => {
    render(ui());
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
  });

  it('does not show a banner for the first connect after page load', () => {
    setSse('connecting');
    render(ui());
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reconnect Now' })).toBeNull();
  });

  it('shows the reconnect message with a countdown that ticks down', () => {
    setSse('reconnecting', Date.now() + 5_000);
    render(ui());

    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to live server...');
    expect(screen.getByText('Next attempt in 5s')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByText('Next attempt in 3s')).toBeInTheDocument();
  });

  it('Reconnect Now calls reconnectNow', () => {
    setSse('reconnecting', Date.now() + 9_000);
    render(ui());
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Now' }));
    expect(sse.reconnectNow).toHaveBeenCalledTimes(1);
  });

  it('disables Reconnect Now while an attempt is already running', () => {
    setSse('reconnecting', Date.now() + 9_000);
    const view = render(ui());
    setSse('connecting');
    view.rerender(ui());
    expect(screen.getByRole('button', { name: 'Reconnect Now' })).toBeDisabled();
    expect(screen.queryByText(/Next attempt/)).toBeNull();
  });

  it('shows Connected! for 1.5s on recovery, refreshes runtime state, then goes away', () => {
    setSse('reconnecting', Date.now() + 3_000);
    const view = render(ui());
    expect(invalidate).not.toHaveBeenCalled();

    setSse('connected');
    view.rerender(ui());
    expect(screen.getByText('Connected!')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect Now' })).toBeNull();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runtime-state'] });

    act(() => { vi.advanceTimersByTime(1_499); });
    expect(screen.getByText('Connected!')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Connected!')).toBeNull();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('shows a paused state with Reconnect Now once the hook has given up', () => {
    setSse('reconnecting', Date.now() + 3_000);
    const view = render(ui());
    setSse('disconnected');
    view.rerender(ui());

    expect(screen.getByText('Live updates paused. We could not reach the server.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect Now' }));
    expect(sse.reconnectNow).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for a signed out user', () => {
    useUserStore.setState({ isAuthenticated: false });
    setSse('reconnecting', Date.now() + 3_000);
    const { container } = render(ui());
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RecoveryOverlay', () => {
  afterEach(cleanup);

  it('still shows the comeback message next to the connection banner', () => {
    useUserStore.setState({ isAuthenticated: true });
    setSse('connected');
    sse.state.eventHistory = [{
      type: 'behavioral_message',
      stats: { id: 'c1', tone: 'calm', text: 'Glad you are back', context: 'comeback', expiresAt: '2999-01-01T00:00:00Z' },
    }];
    render(<QueryClientProvider client={queryClient}><RecoveryOverlay /></QueryClientProvider>);
    expect(screen.getByRole('dialog', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText('Glad you are back')).toBeInTheDocument();
  });
});

describe('secondsUntil', () => {
  it('rounds up and never goes below zero', () => {
    expect(secondsUntil(10_001, 10_000)).toBe(1);
    expect(secondsUntil(12_000, 10_000)).toBe(2);
    expect(secondsUntil(9_000, 10_000)).toBe(0);
  });
});
