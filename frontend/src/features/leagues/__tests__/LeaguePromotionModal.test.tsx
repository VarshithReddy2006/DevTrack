import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The motion helpers read matchMedia at import time and jsdom does not ship it.
const originalMatchMedia = vi.hoisted(() => {
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches: false, media, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(), onchange: null,
  }));
  return original;
});
afterAll(() => { window.matchMedia = originalMatchMedia; });

import { LeaguePromotionCelebration, LeaguePromotionModal } from '../components/LeaguePromotionModal';
import { detectPromotion, loadSeenDivision, promotionPerks, saveSeenDivision } from '../leagueUtils';
import { getCurrentStandings } from '../../../services/leaguesService';
import { useUserStore } from '../../../store/userStore';
import { makeView } from './fixtures';

vi.mock('../../../services/leaguesService', () => ({
  getCurrentStandings: vi.fn(),
  setLeagueParticipation: vi.fn(),
}));

const load = vi.mocked(getCurrentStandings);

function renderCelebration() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><LeaguePromotionCelebration /></QueryClientProvider>);
}

beforeEach(() => {
  load.mockReset();
  localStorage.clear();
  useUserStore.setState({ isAuthenticated: true, user: { id: 'user-1' } as never });
});
afterEach(() => {
  cleanup();
  useUserStore.setState({ isAuthenticated: false, user: null });
});

describe('promotion helpers', () => {
  it('only reports a move up the ladder', () => {
    expect(detectPromotion('silver', 'gold')).toEqual({ from: 'silver', to: 'gold' });
    expect(detectPromotion('bronze', 'platinum')).toEqual({ from: 'bronze', to: 'platinum' });
    expect(detectPromotion('gold', 'gold')).toBeNull();
    expect(detectPromotion('gold', 'silver')).toBeNull();
    expect(detectPromotion(null, 'gold')).toBeNull();
  });

  it('describes the new standing and the next goal', () => {
    expect(promotionPerks('gold', 6, 30)).toEqual([
      'The Gold badge on your league standings',
      'A new 30-player Gold cohort to compete in this week',
      'Finish in the top 6 this week to move up to Platinum',
    ]);
    expect(promotionPerks('grandmaster', 6, 30)[2]).toMatch(/top league/);
  });

  it('ignores stored values that are not divisions', () => {
    localStorage.setItem('devtrack:leagues:seen-division:user-1', 'mythic');
    expect(loadSeenDivision('user-1')).toBeNull();
  });
});

describe('LeaguePromotionModal', () => {
  it('shows the tier change, promotion copy and perks', () => {
    render(<LeaguePromotionModal promotion={{ from: 'silver', to: 'gold', cohortSize: 30, promotionSlots: 6 }} onClaim={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Welcome to Gold League' });
    expect(dialog).toHaveAccessibleDescription(/moved up from Silver to Gold/);
    expect(within(dialog).getByRole('img', { name: 'Tier badge changes from Silver to Gold' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('tier-badge-silver')).toBeInTheDocument();
    expect(within(dialog).getByTestId('tier-badge-gold')).toBeInTheDocument();
    expect(within(dialog).getByText('Finish in the top 6 this week to move up to Platinum')).toBeInTheDocument();
  });

  it('focuses the claim button and keeps Tab inside the dialog', () => {
    render(<LeaguePromotionModal promotion={{ from: 'silver', to: 'gold', cohortSize: 30, promotionSlots: 6 }} onClaim={vi.fn()} />);
    const claim = screen.getByRole('button', { name: /Claim Rewards & Continue/ });
    expect(claim).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(claim).toHaveFocus();
  });

  it('renders nothing without a promotion', () => {
    render(<LeaguePromotionModal promotion={null} onClaim={vi.fn()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('LeaguePromotionCelebration', () => {
  it('opens after a promotion and records the claim', async () => {
    saveSeenDivision('user-1', 'silver');
    load.mockResolvedValue(makeView({ division: 'gold' }));
    renderCelebration();
    fireEvent.click(await screen.findByRole('button', { name: /Claim Rewards & Continue/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(loadSeenDivision('user-1')).toBe('gold');
  });

  it('dismisses with Escape and does not open again', async () => {
    saveSeenDivision('user-1', 'bronze');
    load.mockResolvedValue(makeView({ division: 'silver' }));
    const { unmount } = renderCelebration();
    expect(await screen.findByRole('dialog', { name: 'Welcome to Silver League' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(loadSeenDivision('user-1')).toBe('silver');

    unmount();
    renderCelebration();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stores the first division it sees without celebrating', async () => {
    load.mockResolvedValue(makeView({ division: 'gold' }));
    renderCelebration();
    await waitFor(() => expect(loadSeenDivision('user-1')).toBe('gold'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('updates the stored division quietly after a demotion', async () => {
    saveSeenDivision('user-1', 'gold');
    load.mockResolvedValue(makeView({ division: 'silver' }));
    renderCelebration();
    await waitFor(() => expect(loadSeenDivision('user-1')).toBe('silver'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps each account separate', async () => {
    saveSeenDivision('someone-else', 'bronze');
    load.mockResolvedValue(makeView({ division: 'gold' }));
    renderCelebration();
    await waitFor(() => expect(loadSeenDivision('user-1')).toBe('gold'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(loadSeenDivision('someone-else')).toBe('bronze');
  });

  it('does nothing for users outside the league or signed out', async () => {
    saveSeenDivision('user-1', 'bronze');
    load.mockResolvedValue(makeView({ participating: false, division: null }));
    renderCelebration();
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(loadSeenDivision('user-1')).toBe('bronze');

    cleanup();
    load.mockClear();
    useUserStore.setState({ isAuthenticated: false, user: null });
    renderCelebration();
    expect(load).not.toHaveBeenCalled();
  });
});
