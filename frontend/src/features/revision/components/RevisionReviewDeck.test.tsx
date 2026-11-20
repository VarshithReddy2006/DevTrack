import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisionReviewDeck } from './RevisionReviewDeck';
import type { RevisionCard } from '../../../services/revisionService';

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })) });
});

const revisionApi = vi.hoisted(() => ({ MAX_DUE_CARDS: 50, fetchDueCards: vi.fn(), submitRevisionReview: vi.fn() }));
vi.mock('../../../services/revisionService', () => revisionApi);
vi.mock('../../../services/dashboardService', () => ({ fetchStreakData: vi.fn().mockResolvedValue({ data: { currentStreak: 3 } }) }));

const card: RevisionCard = {
  _id: 'card1', problemKey: 'leetcode:two-sum', title: 'Two Sum',
  difficulty: 'easy', tags: ['Array'], reviewSeq: 4, repetitions: 1,
  easeFactor: 2.5, intervalDays: 1, dueAt: '2026-11-16T00:00:00.000Z',
};

beforeEach(() => {
  revisionApi.fetchDueCards.mockReset();
  revisionApi.submitRevisionReview.mockReset();
});
afterEach(cleanup);

describe('RevisionReviewDeck', () => {
  it('shows a clean empty state', async () => {
    revisionApi.fetchDueCards.mockResolvedValue([]);
    render(<RevisionReviewDeck />);
    expect(await screen.findByText('Deck complete')).toBeTruthy();
    expect(screen.getByText('No problems are due right now.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('submits the current card and review sequence, then completes the deck', async () => {
    revisionApi.fetchDueCards.mockResolvedValue([card]);
    revisionApi.submitRevisionReview.mockResolvedValue({ ...card, reviewSeq: 5, intervalDays: 6 });
    render(<RevisionReviewDeck />);
    expect(await screen.findByText('Two Sum')).toBeTruthy();
    fireEvent.keyDown(window, { key: '2' });
    await waitFor(() => expect(revisionApi.submitRevisionReview).toHaveBeenCalledWith(card, 'hard'));
    expect(await screen.findByText('Deck complete')).toBeTruthy();
    expect(screen.getByText(/You reviewed all 1 cards/)).toBeTruthy();
    const dialog = await screen.findByRole('dialog', { name: 'Review session complete' });
    expect(within(dialog).getByText('1 card reviewed')).toBeTruthy();
    expect(within(dialog).getByText('Hard').nextElementSibling?.textContent).toBe('1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View session summary' }));
    fireEvent.click(screen.getByRole('button', { name: 'View session summary' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('limits a topic deck to due cards with that tag', async () => {
    const tree: RevisionCard = { ...card, _id: 'card2', title: 'Invert Binary Tree', tags: [' Trees '] };
    revisionApi.fetchDueCards.mockResolvedValue([card, tree]);
    render(<RevisionReviewDeck topic="Trees" />);
    expect(await screen.findByText('Invert Binary Tree')).toBeTruthy();
    expect(screen.queryByText('Two Sum')).toBeNull();
    expect(screen.getByText('Card 1 of 1')).toBeTruthy();
    expect(revisionApi.fetchDueCards).toHaveBeenCalledWith(50, expect.anything());
  });

  it('keeps a card visible and offers refresh after a stale review', async () => {
    revisionApi.fetchDueCards.mockResolvedValue([card]);
    revisionApi.submitRevisionReview.mockRejectedValue({ code: 'REVISION_CARD_STALE', statusCode: 409 });
    render(<RevisionReviewDeck />);
    fireEvent.click(await screen.findByRole('button', { name: /Hard/ }));
    expect(await screen.findByText(/changed in another session/)).toBeTruthy();
    expect(screen.getByText('Two Sum')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('counts only saved reviews, waits for the last response, and resets on a new deck', async () => {
    const second = { ...card, _id: 'card2', title: 'Three Sum' };
    revisionApi.fetchDueCards.mockResolvedValueOnce([card, second]).mockResolvedValueOnce([]);
    let resolveLast!: (value: RevisionCard) => void;
    revisionApi.submitRevisionReview.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ ...card, reviewSeq: 5 })
      .mockImplementationOnce(() => new Promise<RevisionCard>(resolve => { resolveLast = resolve; }));
    render(<RevisionReviewDeck />);
    fireEvent.click(await screen.findByRole('button', { name: /Easy/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Easy/ }));
    await screen.findByText('Three Sum');
    fireEvent.click(screen.getByRole('button', { name: /Hard/ }));
    fireEvent.keyDown(window, { key: '2' });
    expect(revisionApi.submitRevisionReview).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(true);
    resolveLast({ ...second, reviewSeq: 5 });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('2 cards reviewed')).toBeTruthy();
    expect(within(dialog).getByText('Again (Failed)').nextElementSibling?.textContent).toBe('0');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Check for more due cards' }));
    await screen.findByText('No problems are due right now.');
    expect(screen.queryByRole('button', { name: 'View session summary' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
