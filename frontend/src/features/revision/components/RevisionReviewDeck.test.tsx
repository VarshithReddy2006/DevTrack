import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisionReviewDeck } from './RevisionReviewDeck';
import type { RevisionCard } from '../../../services/revisionService';

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
  });
});
