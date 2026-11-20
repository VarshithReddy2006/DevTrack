import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CardSummaryModal } from '../components/CardSummaryModal';
import type { SessionSummary } from '../sessionSummary';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })) });
});

afterEach(cleanup);
const summary: SessionSummary = {
  total: 4, ratings: { failed: 1, hard: 1, easy: 2 },
  retention: { before: 74, after: 82 }, expectedXp: 20,
  forecast: [{ date: '2026-11-21', count: 2 }, { date: '2026-11-26', count: 2 }],
};

describe('CardSummaryModal', () => {
  it('shows rating distribution, retention delta, an honest XP reward, and the returned schedule', () => {
    render(<CardSummaryModal summary={summary} open onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Review session complete' });
    expect(within(dialog).getByText('4 cards reviewed')).toBeTruthy();
    expect(within(dialog).getByText('Again (Failed)').nextElementSibling?.textContent).toBe('1');
    expect(within(dialog).getByText('Easy').nextElementSibling?.textContent).toBe('2');
    expect(within(dialog).getByText('Estimated retention: 74% to 82%, +8 percentage points')).toBeTruthy();
    expect(within(dialog).getByText('20', { selector: '.sr-only' })).toBeTruthy();
    expect(within(dialog).getByText(/Award confirmation is unavailable/)).toBeTruthy();
    expect(within(dialog).getByRole('region', { name: 'Next review forecast' }).querySelectorAll('time')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Done' })).toBe(document.activeElement);
  });

  it('traps Tab in both directions and restores focus to its opener after Escape', async () => {
    const onClose = vi.fn();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = render(<CardSummaryModal summary={summary} open onClose={onClose} />);
    const done = screen.getByRole('button', { name: 'Done' });
    const close = screen.getByRole('button', { name: 'Close dialog' });
    fireEvent.keyDown(done, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);
    fireEvent.keyDown(done, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<CardSummaryModal summary={summary} open={false} onClose={onClose} />);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it('supports missing estimates and dismisses with Done', () => {
    const onClose = vi.fn();
    render(<CardSummaryModal summary={{ ...summary, retention: null, forecast: [] }} open onClose={onClose} />);
    expect(screen.getByText('Retention estimate unavailable for this session.')).toBeTruthy();
    expect(screen.getByText('Review schedule unavailable.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
