import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TieredQuestsDrawer } from '../components/TieredQuestsDrawer';
import type { ApiQuest } from '../services/questsService';

const mocks = vi.hoisted(() => ({
  useQuests: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('../hooks/useQuests', () => ({ useQuests: mocks.useQuests }));
vi.mock('../hooks/useClaimQuest', () => ({
  useClaimQuest: () => ({ isPending: false, variables: undefined, mutate: mocks.mutate }),
}));

const daily: ApiQuest = {
  questId: 'daily-1', definitionId: 'definition-1', periodKey: 'daily:2026-11-19', cadence: 'daily', division: 'bronze', kind: 'dsa_solve',
  title: 'Solve 2 distinct problems', targetCount: 2, currentCount: 1, completed: false, claimed: false,
  completedAt: null, claimedAt: null, startsAt: '2026-11-19T00:00:00.000Z', expiresAt: '2026-11-20T00:00:00.000Z', xpReward: 20, trophyReward: 1,
};

const completed: ApiQuest = { ...daily, questId: 'daily-2', title: 'Solve 3 distinct problems', targetCount: 3, currentCount: 3, completed: true };

beforeEach(() => {
  vi.setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
  mocks.mutate.mockReset();
  mocks.useQuests.mockReturnValue({ data: { serverTime: '2026-11-19T12:00:00.000Z', leagueTrophies: 4, quests: [daily, completed, { ...daily, questId: 'weekly-1', cadence: 'weekly', title: 'Solve 10 distinct problems' }] }, isLoading: false, isError: false });
});

afterEach(() => vi.useRealTimers());

describe('TieredQuestsDrawer', () => {
  it('renders daily progress and a server-aligned reset countdown', () => {
    render(<TieredQuestsDrawer open onClose={vi.fn()} />);

    expect(screen.getByText('Solve 2 distinct problems')).toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(screen.getByText('12h 0m 0s')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Solve 2 distinct problems progress' })).toHaveAttribute('aria-valuenow', '1');
  });

  it('switches between daily and weekly tabs', () => {
    render(<TieredQuestsDrawer open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Weekly Quests' }));

    expect(screen.getByText('Solve 10 distinct problems')).toBeInTheDocument();
    expect(screen.queryByText('Solve 2 distinct problems')).not.toBeInTheDocument();
  });

  it('only enables claim for completed and unclaimed quests', () => {
    render(<TieredQuestsDrawer open onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'In progress' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Claim +20 XP' })).toBeEnabled();
  });

  it('claims a completed quest and shows the celebration', async () => {
    mocks.mutate.mockImplementation((_id: string, options: { onSuccess: () => void }) => options.onSuccess());
    render(<TieredQuestsDrawer open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Claim +20 XP' }));

    expect(mocks.mutate).toHaveBeenCalledWith('daily-2', expect.any(Object));
    expect(await screen.findByRole('status', { name: 'Reward claimed' })).toBeInTheDocument();
  });

  it('uses the shared drawer accessibility behavior', async () => {
    const onClose = vi.fn();
    render(<TieredQuestsDrawer open onClose={onClose} />);
    const drawer = screen.getByRole('dialog', { name: 'Tiered Quests' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
