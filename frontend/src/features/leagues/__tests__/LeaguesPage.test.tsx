import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LeaguesPage from '../LeaguesPage';
import { getCurrentStandings, setLeagueParticipation } from '../../../services/leaguesService';
import { makeCohort, makeView } from './fixtures';

vi.mock('../../../services/leaguesService', () => ({
  getCurrentStandings: vi.fn(),
  setLeagueParticipation: vi.fn(),
}));

const load = vi.mocked(getCurrentStandings);
const join = vi.mocked(setLeagueParticipation);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchInterval: false } } });
  return render(<QueryClientProvider client={client}><LeaguesPage /></QueryClientProvider>);
}

const idle = makeView({
  participating: false, division: null, cohortId: null, cohortSize: 0,
  promotionSlots: 0, demotionSlots: 0, me: null, standings: [],
});

describe('LeaguesPage', () => {
  beforeEach(() => {
    load.mockReset();
    join.mockReset();
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('shows the standings once loaded', async () => {
    load.mockResolvedValue(makeView());
    renderPage();
    expect(await screen.findByRole('table', { name: 'Weekly league standings' })).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(1 + 30 + 2);
  });

  it('fails gracefully when the endpoint is not available and lets the user retry', async () => {
    load.mockRejectedValueOnce(new Error('Request failed with status code 404'));
    load.mockResolvedValueOnce(makeView());
    renderPage();

    expect(await screen.findByText('Request failed with status code 404')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('joins the league and then shows the cohort', async () => {
    load.mockResolvedValueOnce(idle);
    load.mockResolvedValueOnce(makeView());
    join.mockResolvedValue({ participating: true });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Join weekly league' }));
    await waitFor(() => expect(join).toHaveBeenCalledWith(true));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('reports a failed join', async () => {
    load.mockResolvedValue(idle);
    join.mockRejectedValue(new Error('Server error'));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Join weekly league' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server error');
  });

  it('shows rank changes against the ranks stored on the last visit and stores the new ones', async () => {
    localStorage.setItem('devtrack:leagues:ranks:2026-W47:c1', JSON.stringify({ 'user-1': 4, 'user-2': 2 }));
    load.mockResolvedValue(makeView());
    renderPage();

    expect(await screen.findByLabelText('Up 3 places')).toBeInTheDocument();
    expect(screen.getAllByLabelText('No change')).toHaveLength(1);
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('devtrack:leagues:ranks:2026-W47:c1') ?? '{}');
      expect(Object.keys(stored)).toHaveLength(30);
      expect(stored['user-1']).toBe(1);
    });
  });

  it('shows no change column on the very first visit', async () => {
    load.mockResolvedValue(makeView({ standings: makeCohort(30, 1) }));
    renderPage();
    await screen.findByRole('table');
    expect(screen.queryByRole('columnheader', { name: 'Change' })).toBeNull();
  });
});
