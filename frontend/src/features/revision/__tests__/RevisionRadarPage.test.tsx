import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RevisionRadarPage from '../RevisionRadarPage';
import type { RevisionAnalytics, RevisionCard } from '../../../services/revisionService';
import { useUserStore } from '../../../store/userStore';

const revisionApi = vi.hoisted(() => ({
  MAX_DUE_CARDS: 50,
  fetchDueCards: vi.fn(),
  fetchRevisionAnalytics: vi.fn(),
  submitRevisionReview: vi.fn(),
}));
vi.mock('../../../services/revisionService', () => revisionApi);
vi.mock('../../../services/dashboardService', () => ({
  fetchStreakData: vi.fn().mockResolvedValue({ success: true, data: { currentStreak: 4 } }),
}));

const twoSum: RevisionCard = {
  _id: 'card-array', problemKey: 'leetcode:two-sum', title: 'Two Sum', difficulty: 'easy',
  tags: ['Array'], reviewSeq: 2, repetitions: 1, easeFactor: 2.5, intervalDays: 1,
  dueAt: '2020-01-01T00:00:00.000Z',
};
const invertTree: RevisionCard = {
  _id: 'card-tree', problemKey: 'leetcode:invert-binary-tree', title: 'Invert Binary Tree', difficulty: 'easy',
  tags: ['Trees'], reviewSeq: 1, repetitions: 0, easeFactor: 2.5, intervalDays: 1,
  dueAt: new Date().toISOString(),
};

function makeAnalytics(overrides: Partial<RevisionAnalytics> = {}): RevisionAnalytics {
  return {
    asOf: new Date().toISOString(),
    totalCards: 3,
    cardsDueToday: 2,
    retentionPercentage: 63.4,
    mastery: { learning: 1, reviewing: 1, mastered: 1 },
    patterns: [
      { pattern: 'Array', totalCards: 2, retentionPercentage: 91, struggleRate: 0 },
      { pattern: 'Trees', totalCards: 1, retentionPercentage: 32, struggleRate: 100 },
    ],
    forecast: [],
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><RevisionRadarPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  revisionApi.fetchDueCards.mockReset().mockResolvedValue([twoSum, invertTree]);
  revisionApi.fetchRevisionAnalytics.mockReset().mockResolvedValue(makeAnalytics());
  revisionApi.submitRevisionReview.mockReset();
  useUserStore.setState({ user: { id: 'user-1' } as never });
});
afterEach(() => {
  cleanup();
  useUserStore.setState({ user: null });
});

describe('RevisionRadarPage', () => {
  it('shows cards due today, overdue count, memory strength and streak', async () => {
    renderPage();
    const overview = await screen.findByRole('region', { name: 'Revision overview' });
    expect(within(overview).getByText('Cards due today').parentElement).toHaveTextContent('2');
    expect(await within(overview).findByText('1 overdue')).toBeInTheDocument();
    expect(within(overview).getByText('63%')).toBeInTheDocument();
    expect(await within(overview).findByText('4 days')).toBeInTheDocument();
  });

  it('colours heatmap cells by retention level, weakest topic first', async () => {
    renderPage();
    const trees = await screen.findByRole('button', { name: 'Trees: 32% retention, Critical, 1 card' });
    const array = screen.getByRole('button', { name: 'Array: 91% retention, Mastered, 2 cards' });
    expect(trees).toHaveAttribute('data-level', 'critical');
    expect(array).toHaveAttribute('data-level', 'mastered');
    expect(trees.compareDocumentPosition(array) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('starts a review deck filtered to the selected topic chip', async () => {
    renderPage();
    const chips = await screen.findByRole('group', { name: 'Filter review by topic' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Trees' }));
    expect(within(chips).getByRole('button', { name: 'Trees' })).toHaveAttribute('aria-pressed', 'true');

    const start = await screen.findByRole('button', { name: 'Start Trees review' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    expect(await screen.findByRole('heading', { name: 'Invert Binary Tree' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Two Sum' })).not.toBeInTheDocument();
    expect(revisionApi.fetchDueCards).toHaveBeenLastCalledWith(50, expect.anything());
  });

  it('selects a topic from the heatmap and clears it from the chips', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^Array: 91% retention/ }));
    const chips = screen.getByRole('group', { name: 'Filter review by topic' });
    expect(within(chips).getByRole('button', { name: 'Array' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(chips).getByRole('button', { name: 'All topics' }));
    expect(within(chips).getByRole('button', { name: 'All topics' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Start Daily Review' })).toBeInTheDocument();
  });

  it('disables the start button when nothing is due', async () => {
    revisionApi.fetchDueCards.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No cards are due right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Daily Review' })).toBeDisabled();
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  });

  it('shows 50+ overdue and keeps topic review available when the due summary is full', async () => {
    const overdueArrays = Array.from({ length: 50 }, (_, index) => ({ ...twoSum, _id: `card-${index}` }));
    revisionApi.fetchDueCards.mockResolvedValue(overdueArrays);
    renderPage();
    expect(await screen.findByText('50+ overdue')).toBeInTheDocument();
    const chips = screen.getByRole('group', { name: 'Filter review by topic' });
    fireEvent.click(within(chips).getByRole('button', { name: 'Trees' }));
    expect(screen.getByRole('button', { name: 'Start Trees review' })).toBeEnabled();
    expect(screen.queryByText('No Trees cards are due right now.')).not.toBeInTheDocument();
  });

  it('shows an empty state when the user has no revision cards', async () => {
    revisionApi.fetchRevisionAnalytics.mockResolvedValue(makeAnalytics({ totalCards: 0, cardsDueToday: 0, retentionPercentage: 0, patterns: [] }));
    renderPage();
    expect(await screen.findByRole('heading', { name: 'No revision cards yet' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start Daily Review' })).not.toBeInTheDocument();
  });

  it('reports an analytics failure and recovers on retry', async () => {
    revisionApi.fetchRevisionAnalytics.mockRejectedValueOnce(new Error('Service unavailable'));
    renderPage();
    expect(await screen.findByText('Service unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('region', { name: 'Revision overview' })).toBeInTheDocument();
  });
});
