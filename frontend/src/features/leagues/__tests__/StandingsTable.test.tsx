import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StandingsTable } from '../components/StandingsTable';
import { makeCohort, makeView } from './fixtures';

const scrollIntoView = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  scrollIntoView.mockClear();
  // jsdom has no scrollIntoView of its own
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function bodyRows() {
  const table = screen.getByRole('table', { name: 'Weekly league standings' });
  return Array.from(table.querySelectorAll('tbody > tr'));
}

describe('StandingsTable rows', () => {
  it('renders all 30 cohort members in rank order with formatted weekly XP', () => {
    render(<StandingsTable view={makeView()} />);

    const members = bodyRows().filter((row) => !row.hasAttribute('data-separator'));
    expect(members).toHaveLength(30);
    const ranks = members.map((row) => within(row as HTMLElement).getByRole('rowheader').textContent?.match(/^\d+/)?.[0]);
    expect(ranks).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1)));

    const first = members[0] as HTMLElement;
    expect(within(first).getByText('Dev Number 1')).toBeInTheDocument();
    expect(within(first).getByText('@dev1')).toBeInTheDocument();
    expect(within(first).getByText('3,040')).toBeInTheDocument();
    expect(within(members[29] as HTMLElement).getByText('140')).toBeInTheDocument();
  });

  it('uses a semantic table with column headers', () => {
    render(<StandingsTable view={makeView()} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Rank', 'User', 'Weekly XP']);
  });

  it('falls back to the username, then Anonymous, and an initial when there is no avatar', () => {
    const standings = makeCohort(10, 1);
    standings[0] = { ...standings[0], displayName: null, username: 'solo', avatarUrl: null };
    standings[1] = { ...standings[1], displayName: null, username: null, avatarUrl: null };
    render(<StandingsTable view={makeView({ standings })} />);
    const rows = bodyRows();
    expect(within(rows[0] as HTMLElement).getByText('solo')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('S')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Anonymous')).toBeInTheDocument();
  });

  it('summarises the division, cohort size and my own rank', () => {
    render(<StandingsTable view={makeView()} />);
    expect(screen.getByRole('heading', { name: 'Gold league' })).toBeInTheDocument();
    expect(screen.getByText(/30 players/)).toBeInTheDocument();
    expect(screen.getByText(/You are #12 with 1,940 XP/)).toBeInTheDocument();
  });
});

describe('StandingsTable current user', () => {
  it('highlights only my row and marks it as current', () => {
    render(<StandingsTable view={makeView()} />);
    const current = screen.getAllByRole('row').filter((row) => row.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(within(current[0]).getByText('Dev Number 12')).toBeInTheDocument();
    expect(within(current[0]).getByText('You')).toBeInTheDocument();
    expect(current[0].className).toContain('bg-indigo-50');
  });

  it('scrolls my row into view', () => {
    render(<StandingsTable view={makeView()} />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(
      screen.getAllByRole('row').find((row) => row.getAttribute('aria-current') === 'true'),
    );
  });

  it('does not try to scroll when I am not in the list', () => {
    const standings = makeCohort(30, -1);
    render(<StandingsTable view={makeView({ standings, me: null })} />);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('StandingsTable zones', () => {
  it('puts the promotion separator right after rank 6 and the demotion separator right before rank 25', () => {
    render(<StandingsTable view={makeView()} />);
    const rows = bodyRows();
    const promotionIndex = rows.findIndex((row) => row.getAttribute('data-separator') === 'promotion');
    const demotionIndex = rows.findIndex((row) => row.getAttribute('data-separator') === 'demotion');

    expect(within(rows[promotionIndex - 1] as HTMLElement).getByRole('rowheader')).toHaveTextContent(/^6/);
    expect(within(rows[promotionIndex + 1] as HTMLElement).getByRole('rowheader')).toHaveTextContent(/^7/);
    expect(within(rows[demotionIndex - 1] as HTMLElement).getByRole('rowheader')).toHaveTextContent(/^24/);
    expect(within(rows[demotionIndex + 1] as HTMLElement).getByRole('rowheader')).toHaveTextContent(/^25/);
    expect(rows[promotionIndex]).toHaveTextContent('Promotion zone: top 6 move up');
    expect(rows[demotionIndex]).toHaveTextContent('Demotion zone: bottom 6 move down');
    expect(document.querySelectorAll('[data-separator]')).toHaveLength(2);
  });

  it('takes the slot counts from the API, not a fixed number', () => {
    render(<StandingsTable view={makeView({ promotionSlots: 3, demotionSlots: 2 })} />);
    const rows = bodyRows();
    const promotionIndex = rows.findIndex((row) => row.getAttribute('data-separator') === 'promotion');
    const demotionIndex = rows.findIndex((row) => row.getAttribute('data-separator') === 'demotion');
    expect(within(rows[promotionIndex - 1] as HTMLElement).getByRole('rowheader')).toHaveTextContent(/^3/);
    expect(within(rows[demotionIndex + 1] as HTMLElement).getByRole('rowheader')).toHaveTextContent(/^29/);
  });

  it('draws no separators for a tiny cohort with zero slots', () => {
    render(<StandingsTable view={makeView({ standings: makeCohort(4, 2) })} />);
    expect(document.querySelectorAll('[data-separator]')).toHaveLength(0);
    expect(bodyRows()).toHaveLength(4);
  });

  it('tags rows with their zone and announces it to screen readers', () => {
    render(<StandingsTable view={makeView()} />);
    const members = bodyRows().filter((row) => !row.hasAttribute('data-separator'));
    expect(members.map((row) => row.getAttribute('data-zone'))).toEqual([
      ...Array(6).fill('promotion'),
      ...Array(18).fill('safe'),
      ...Array(6).fill('demotion'),
    ]);
    expect(within(members[0] as HTMLElement).getByText('(Promotion zone)')).toBeInTheDocument();
    expect(within(members[29] as HTMLElement).getByText('(Demotion zone)')).toBeInTheDocument();
    expect(within(members[10] as HTMLElement).queryByText(/zone/)).toBeNull();
  });
});

describe('StandingsTable rank changes', () => {
  it('shows no change column without an earlier snapshot', () => {
    render(<StandingsTable view={makeView()} />);
    expect(screen.queryByRole('columnheader', { name: 'Change' })).toBeNull();
    expect(screen.queryByLabelText('No change')).toBeNull();
  });

  it('shows gained, lost, unchanged and new members with text labels', () => {
    const previousRanks = { 'user-1': 3, 'user-2': 1, 'user-3': 3, 'user-4': 4 };
    render(<StandingsTable view={makeView()} previousRanks={previousRanks} />);
    const rows = bodyRows();

    expect(screen.getByRole('columnheader', { name: 'Change' })).toBeInTheDocument();
    const up = within(rows[0] as HTMLElement).getByLabelText('Up 2 places');
    expect(up).toHaveTextContent('+2');
    const down = within(rows[1] as HTMLElement).getByLabelText('Down 1 place');
    expect(down).toHaveTextContent('-1');
    expect(within(rows[2] as HTMLElement).getByLabelText('No change')).toHaveTextContent('=');
    expect(within(rows[10] as HTMLElement).getByLabelText('New this time')).toBeInTheDocument();
  });

  it('keeps separator rows as wide as the extra column', () => {
    render(<StandingsTable view={makeView()} previousRanks={{ 'user-1': 1 }} />);
    expect(document.querySelector('[data-separator="promotion"] td')).toHaveAttribute('colspan', '4');
  });
});

describe('StandingsTable week countdown', () => {
  it('shows days, hours and minutes until the reset and ticks down', () => {
    // 6d 12h before 2026-11-23T00:00Z
    render(<StandingsTable view={makeView()} />);
    expect(screen.getByText('Week resets in', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('6d 12h 0m')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(61_000); });
    expect(screen.getByText('6d 11h 58m')).toBeInTheDocument();
  });

  it('calls onWeekEnd once when the week runs out', () => {
    const onWeekEnd = vi.fn();
    vi.setSystemTime(new Date('2026-11-22T23:59:58Z'));
    render(<StandingsTable view={makeView()} onWeekEnd={onWeekEnd} />);
    expect(onWeekEnd).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByText(/Week ended/)).toBeInTheDocument();
    expect(onWeekEnd).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(onWeekEnd).toHaveBeenCalledTimes(1);
  });
});

describe('StandingsTable when not participating', () => {
  const idle = makeView({
    participating: false, division: null, cohortId: null, cohortSize: 0,
    promotionSlots: 0, demotionSlots: 0, me: null, standings: [],
  });

  it('offers a join button instead of a table', () => {
    const onJoin = vi.fn();
    render(<StandingsTable view={idle} onJoin={onJoin} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('heading', { name: 'You are not in a weekly league' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Join weekly league' }));
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(screen.getByText('6d 12h 0m')).toBeInTheDocument();
  });

  it('disables the button while joining', () => {
    render(<StandingsTable view={idle} onJoin={vi.fn()} joining />);
    expect(screen.getByRole('button', { name: 'Joining...' })).toBeDisabled();
  });
});
