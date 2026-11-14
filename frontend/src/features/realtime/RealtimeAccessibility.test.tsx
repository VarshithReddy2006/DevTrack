import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { AchievementReveal } from './AchievementReveal';
import { BehavioralMessageBar } from './BehavioralMessageBar';

const sse = vi.hoisted(() => {
  const originalMatchMedia = window.matchMedia;
  window.matchMedia = vi.fn((media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }) as unknown as MediaQueryList);
  return { eventHistory: [] as unknown[], originalMatchMedia };
});
vi.mock('../../hooks/useSse', () => ({ useSse: () => sse }));

afterAll(() => { window.matchMedia = sse.originalMatchMedia; });

afterEach(() => {
  cleanup();
  sse.eventHistory = [];
});

it('focuses Dismiss, traps Tab in both directions, and restores focus on Escape', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open achievement</button>
        <AchievementReveal open={open} name="First milestone" onDismiss={() => setOpen(false)} />
      </>
    );
  }

  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open achievement' });
  opener.focus();
  fireEvent.click(opener);

  const dialog = screen.getByRole('dialog', { name: 'Achievement unlocked: First milestone' });
  const dismiss = screen.getByRole('button', { name: 'Dismiss' });
  expect(dialog).toContainElement(dismiss);
  expect(dismiss).toHaveFocus();
  expect(fireEvent.keyDown(dismiss, { key: 'Tab' })).toBe(false);
  expect(dismiss).toHaveFocus();
  expect(fireEvent.keyDown(dismiss, { key: 'Tab', shiftKey: true })).toBe(false);
  expect(dismiss).toHaveFocus();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(opener).toHaveFocus());
});

function message(stats: Record<string, unknown>) {
  return { type: 'behavioral_message', stats };
}

it('dismisses one message by its SSE ID and keeps it dismissed if replayed', () => {
  const newest = message({ messageId: 'new', tone: 'calm', text: 'Newest message' });
  const older = message({ id: 'old', tone: 'calm', text: 'Older message' });
  sse.eventHistory = [
    message({ messageId: 'expired', tone: 'calm', text: 'Expired message', expiresAt: '2000-01-01T00:00:00Z' }),
    newest,
    older,
  ];
  const view = render(<MemoryRouter><BehavioralMessageBar /></MemoryRouter>);

  expect(screen.queryByText('Expired message')).toBeNull();
  expect(screen.getByText('Newest message')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('Newest message')).toBeNull();
  expect(screen.getByText('Older message')).toBeInTheDocument();

  sse.eventHistory = [newest, older];
  view.rerender(<MemoryRouter><BehavioralMessageBar /></MemoryRouter>);
  expect(screen.queryByText('Newest message')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('Older message')).toBeNull();
});

it('navigates through React Router while keeping the message bar mounted', () => {
  function Location() {
    const location = useLocation();
    return <p>{location.pathname}{location.search}</p>;
  }

  sse.eventHistory = [message({
    messageId: 'route',
    tone: 'supportive',
    text: 'Review your progress',
    action: { label: 'Open dashboard', route: '/dashboard?from=message' },
  })];
  render(<MemoryRouter><BehavioralMessageBar /><Location /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Open dashboard' }));
  expect(screen.getByText('/dashboard?from=message')).toBeInTheDocument();
  expect(screen.getByText('Review your progress')).toBeInTheDocument();
});
