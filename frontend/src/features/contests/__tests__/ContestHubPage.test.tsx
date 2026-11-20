import type { ReactElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ContestHubPage from '../ContestHubPage';
import { ContestCard } from '../components/ContestCard';
import { PlatformFilterPills } from '../components/PlatformFilterPills';
import type { UpcomingContest } from '../contestsUtils';
import * as contestsService from '../../../services/contestsService';

// Mock contest data
const mockContests: UpcomingContest[] = [
  {
    externalId: 'weekly-contest-400',
    platform: 'leetcode',
    contestName: 'LeetCode Weekly Contest 400',
    startTime: new Date(Date.now() + 86400000).toISOString(), // 1 day in future
    endTime: new Date(Date.now() + 86400000 + 5400000).toISOString(), // 90 min duration
    durationSeconds: 5400,
    url: 'https://leetcode.com/contest/weekly-contest-400',
    phase: 'BEFORE',
    kind: 'scheduled',
  },
  {
    externalId: 'cf-round-950',
    platform: 'codeforces',
    contestName: 'Codeforces Round 950 (Div. 2)',
    startTime: new Date(Date.now() + 3600000 * 2).toISOString(), // 2 hours in future
    endTime: new Date(Date.now() + 3600000 * 4).toISOString(), // 2 hours duration
    durationSeconds: 7200,
    url: 'https://codeforces.com/contest/950',
    phase: 'BEFORE',
    kind: 'scheduled',
  },
  {
    externalId: 'abc-350',
    platform: 'atcoder',
    contestName: 'AtCoder Beginner Contest 350',
    startTime: new Date(Date.now() - 1800000).toISOString(), // started 30 min ago
    endTime: new Date(Date.now() + 3600000).toISOString(), // ends in 1 hour
    durationSeconds: 6000,
    url: 'https://atcoder.jp/contests/abc350',
    phase: 'BEFORE',
    kind: 'scheduled',
  },
  {
    externalId: 'starters-135',
    platform: 'codechef',
    contestName: 'Starters 135 Division 2',
    startTime: new Date(Date.now() - 7200000).toISOString(), // ended
    endTime: new Date(Date.now() - 3600000).toISOString(),
    durationSeconds: 7200,
    url: 'https://www.codechef.com/START135',
    phase: 'BEFORE',
    kind: 'scheduled',
  },
];

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
      },
    },
  });
}

function renderWithClient(ui: ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  );
}

describe('PlatformFilterPills component', () => {
  it('renders all platform filter options with active state and count badges', () => {
    const onChange = vi.fn();
    const counts = { all: 4, leetcode: 1, codeforces: 1, atcoder: 1, codechef: 1 };

    render(
      <PlatformFilterPills
        selected="all"
        onChange={onChange}
        counts={counts}
      />
    );

    expect(screen.getByRole('button', { name: /All Platforms contests \(4\)/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /LeetCode contests \(1\)/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /Codeforces contests \(1\)/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /AtCoder contests \(1\)/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /CodeChef contests \(1\)/i })).toBeDefined();

    // Clicking LeetCode triggers onChange
    fireEvent.click(screen.getByRole('button', { name: /LeetCode contests/i }));
    expect(onChange).toHaveBeenCalledWith('leetcode');
  });
});

describe('ContestCard component', () => {
  it('renders platform badge, contest title, difficulty, local time, and countdown', () => {
    const contest = mockContests[0]; // LeetCode Weekly Contest 400
    render(<ContestCard contest={contest} isReminderSet={false} />);

    expect(screen.getByText('LeetCode')).toBeDefined();
    expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
    expect(screen.getByText('Weekly')).toBeDefined(); // inferred difficulty
    expect(screen.getByText(/Duration: 1h 30m/i)).toBeDefined();
    expect(screen.getByTestId('contest-countdown').textContent).toMatch(/Starts in/);
    expect(screen.getByRole('button', { name: /Set reminder for LeetCode Weekly Contest 400/i })).toBeDefined();
  });

  it('renders live status badge and live countdown when contest is ongoing', () => {
    const liveContest = mockContests[2]; // AtCoder
    render(<ContestCard contest={liveContest} isReminderSet={false} />);

    expect(screen.getAllByText('Live Now').length).toBeGreaterThan(0);
  });

  it('toggles reminder when button is clicked', () => {
    const contest = mockContests[1];
    const onToggle = vi.fn();

    render(<ContestCard contest={contest} isReminderSet={false} onToggleReminder={onToggle} />);

    const reminderBtn = screen.getByRole('button', { name: /Set reminder for/i });
    expect(reminderBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(reminderBtn);
    expect(onToggle).toHaveBeenCalledWith(contest);
  });

  it('displays active reminder state when isReminderSet is true', () => {
    const contest = mockContests[1];
    render(<ContestCard contest={contest} isReminderSet={true} />);

    const reminderBtn = screen.getByRole('button', { name: /Remove reminder for/i });
    expect(reminderBtn.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Reminder Set')).toBeDefined();
  });
});

describe('ContestHubPage integration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(contestsService, 'getUpcomingContests').mockResolvedValue(mockContests);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the contest grid with upcoming contests across platforms', async () => {
    renderWithClient(<ContestHubPage />);

    expect(screen.getByText('Contest Hub')).toBeDefined();

    // Wait for contests to load
    await waitFor(() => {
      expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
      expect(screen.getByText('Codeforces Round 950 (Div. 2)')).toBeDefined();
      expect(screen.getByText('AtCoder Beginner Contest 350')).toBeDefined();
      expect(screen.getByText('Starters 135 Division 2')).toBeDefined();
    });

    const cards = screen.getAllByTestId('contest-card');
    expect(cards.length).toBe(4);
  });

  it('filters contests by platform pill click (LeetCode, Codeforces, AtCoder)', async () => {
    renderWithClient(<ContestHubPage />);

    await waitFor(() => {
      expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
    });

    // Click LeetCode filter pill
    const lcButton = screen.getByRole('button', { name: /LeetCode contests/i });
    fireEvent.click(lcButton);

    expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
    expect(screen.queryByText('Codeforces Round 950 (Div. 2)')).toBeNull();
    expect(screen.queryByText('AtCoder Beginner Contest 350')).toBeNull();

    // Click Codeforces filter pill
    const cfButton = screen.getByRole('button', { name: /Codeforces contests/i });
    fireEvent.click(cfButton);

    expect(screen.queryByText('LeetCode Weekly Contest 400')).toBeNull();
    expect(screen.getByText('Codeforces Round 950 (Div. 2)')).toBeDefined();

    // Click All Platforms to restore
    const allButton = screen.getByRole('button', { name: /All Platforms contests/i });
    fireEvent.click(allButton);

    expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
    expect(screen.getByText('Codeforces Round 950 (Div. 2)')).toBeDefined();
  });

  it('filters contests by search query', async () => {
    renderWithClient(<ContestHubPage />);

    await waitFor(() => {
      expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
    });

    const searchInput = screen.getByPlaceholderText(/Search contests or platforms/i);
    fireEvent.change(searchInput, { target: { value: 'Round 950' } });

    expect(screen.getByText('Codeforces Round 950 (Div. 2)')).toBeDefined();
    expect(screen.queryByText('LeetCode Weekly Contest 400')).toBeNull();
  });

  it('filters contests by status (live now)', async () => {
    renderWithClient(<ContestHubPage />);

    await waitFor(() => {
      expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
    });

    const liveStatusBtn = screen.getByRole('button', { name: 'Live Now' });
    fireEvent.click(liveStatusBtn);

    // AtCoder ABC 350 is the only live contest
    expect(screen.getByText('AtCoder Beginner Contest 350')).toBeDefined();
    expect(screen.queryByText('LeetCode Weekly Contest 400')).toBeNull();
  });

  it('toggles reminder and persists to localStorage', async () => {
    renderWithClient(<ContestHubPage />);

    await waitFor(() => {
      expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
    });

    const reminderBtn = screen.getByRole('button', {
      name: /Set reminder for LeetCode Weekly Contest 400/i,
    });
    fireEvent.click(reminderBtn);

    // Should now say "Reminder Set"
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: /Remove reminder for LeetCode Weekly Contest 400/i,
        })
      ).toBeDefined();
    });

    // Check localStorage
    const saved = JSON.parse(localStorage.getItem('devtrack_contest_reminders') || '[]');
    expect(saved).toContain('leetcode:weekly-contest-400');
  });

  it('displays empty state when no contests match and allows resetting filters', async () => {
    renderWithClient(<ContestHubPage />);

    await waitFor(() => {
      expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
    });

    const searchInput = screen.getByPlaceholderText(/Search contests or platforms/i);
    fireEvent.change(searchInput, { target: { value: 'nonexistent-contest-query' } });

    expect(screen.getByTestId('empty-contests')).toBeDefined();
    expect(screen.getByText('No matching contests found')).toBeDefined();

    // Reset filters
    const resetBtn = screen.getByRole('button', { name: /Reset filters/i });
    fireEvent.click(resetBtn);

    expect(screen.getByText('LeetCode Weekly Contest 400')).toBeDefined();
  });
});
