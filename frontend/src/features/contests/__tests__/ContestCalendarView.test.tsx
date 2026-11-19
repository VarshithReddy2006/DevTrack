import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContestCalendarView } from '../components/ContestCalendarView';
import { calendarContests, calendarDays, contestCollisions, contestReminderIcs, contestsOnDay, localDateKey, safeContestUrl } from '../contestCalendar';
import type { UpcomingContest } from '../contestsUtils';

const day = (date: number, hour = 10, minute = 0) => new Date(2024, 1, date, hour, minute);
function event(id: string, start = day(21), end = day(21, 11), platform: UpcomingContest['platform'] = 'leetcode'): UpcomingContest {
  return { externalId: id, platform, contestName: `Round ${id}`, startTime: start.toISOString(), endTime: end.toISOString(), durationSeconds: (end.getTime() - start.getTime()) / 1000, url: `https://example.com/contest/${id}`, phase: 'BEFORE', kind: 'scheduled' };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.style.overflow = ''; });

describe('local calendar dates and interval placement', () => {
  it('aligns a leap February to Monday and includes the leap day', () => {
    const dates = calendarDays(day(21), 'month').map(localDateKey);
    expect(dates).toHaveLength(35); expect(dates[0]).toBe('2024-01-29'); expect(dates[3]).toBe('2024-02-01');
    expect(dates).toContain('2024-02-29'); expect(dates[34]).toBe('2024-03-03');
  });
  it('handles a four-week February and a week crossing the year boundary', () => {
    expect(calendarDays(new Date(2021, 1, 15), 'month')).toHaveLength(28);
    const week = calendarDays(new Date(2027, 0, 1), 'week').map(localDateKey);
    expect(week).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    expect(() => calendarDays(new Date(NaN), 'month')).toThrow(/valid calendar date/);
  });
  it('preserves local midnight across DST weeks without fixed-duration day arithmetic', () => {
    for (const anchor of [new Date(2026, 2, 8), new Date(2026, 10, 1)]) {
      const dates = calendarDays(anchor, 'week');
      expect(dates.every(value => value.getHours() === 0)).toBe(true);
      for (let i = 1; i < dates.length; i++) expect(localDateKey(new Date(dates[i - 1].getFullYear(), dates[i - 1].getMonth(), dates[i - 1].getDate() + 1))).toBe(localDateKey(dates[i]));
    }
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/New_York') {
      const spring = calendarDays(new Date(2026, 2, 15), 'month');
      const fall = calendarDays(new Date(2026, 10, 15), 'month');
      expect(spring.find(d => localDateKey(d) === '2026-03-09')!.getTime() - spring.find(d => localDateKey(d) === '2026-03-08')!.getTime()).toBe(23 * 3600000);
      expect(fall.find(d => localDateKey(d) === '2026-11-02')!.getTime() - fall.find(d => localDateKey(d) === '2026-11-01')!.getTime()).toBe(25 * 3600000);
    }
  });
  it('uses half-open day windows for overnight and midnight-ending events', () => {
    const entries = calendarContests([event('night', day(21, 23), day(22, 2)), event('midnight', day(21, 22), day(22, 0))]);
    expect(contestsOnDay(entries, day(21, 15)).map(x => x.key)).toEqual(['leetcode:midnight', 'leetcode:night']);
    expect(contestsOnDay(entries, day(22, 0)).map(x => x.key)).toEqual(['leetcode:night']);
    expect(contestsOnDay(entries, day(23, 0))).toEqual([]);
  });
  it('omits duplicate identities and invalid time ranges without mutating input', () => {
    const input = [event('b'), event('a'), event('a'), { ...event('bad'), startTime: 'invalid' }, event('zero', day(21), day(21)), event('reverse', day(22), day(21))];
    expect(calendarContests(input).map(x => x.key)).toEqual(['leetcode:a', 'leetcode:b']); expect(input).toHaveLength(6);
  });
});

describe('collisions and calendar reminders', () => {
  it('detects containment and simultaneous starts while allowing adjacent endpoints', () => {
    const adjacent = calendarContests([event('a', day(21, 10), day(21, 11)), event('b', day(21, 11), day(21, 12))]);
    expect(contestCollisions(adjacent).count).toBe(0);
    const overlap = calendarContests([event('a', day(21, 10), day(21, 13)), event('b', day(21, 10), day(21, 11)), event('c', day(21, 10, 30), day(21, 12))]);
    const result = contestCollisions(overlap.reverse()); expect(result.count).toBe(3); expect(result.keys.size).toBe(3);
  });
  it('counts dense overlaps exactly while bounding the rendered preview', () => {
    const result = contestCollisions(calendarContests(Array.from({ length: 100 }, (_, i) => event(String(i)))));
    expect(result.count).toBe(4950); expect(result.keys.size).toBe(100); expect(result.preview).toHaveLength(8);
  });
  it('generates an escaped UTC event with a real 15-minute DISPLAY alarm', () => {
    const content = contestReminderIcs({ ...event('alarm'), contestName: 'Round; one\nBEGIN:VALARM' });
    expect(content).toContain('TRIGGER:-PT15M\r\nACTION:DISPLAY');
    expect(content.match(/^BEGIN:VEVENT$/gm)).toHaveLength(1); expect(content.match(/^BEGIN:VALARM$/gm)).toHaveLength(1);
    expect(content).toContain('SUMMARY:Round\\; one\\nBEGIN:VALARM');
    expect(content).toContain(event('alarm').startTime.replace(/[-:]/g, '').replace('.000Z', 'Z'));
  });
  it('rejects executable, relative and credential-bearing URLs without hiding the event', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'https://user:secret@example.com/']) expect(safeContestUrl(value)).toBeUndefined();
    expect(safeContestUrl('https://example.com/round')).toBe('https://example.com/round');
    expect(contestReminderIcs({ ...event('a'), url: 'javascript:alert(1)' })).not.toContain('javascript:');
  });
});

describe('ContestCalendarView', () => {
  it('renders the complete monthly table with correct weekday alignment', () => {
    const { container } = render(<ContestCalendarView contests={[event('a')]} initialDate={day(21)} />);
    expect(screen.getByRole('table', { name: /Monthly contest schedule/ })).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(7); expect(container.querySelectorAll('td[data-date]')).toHaveLength(35);
    expect(container.querySelector('tbody tr td:nth-child(4)')?.getAttribute('data-date')).toBe('2024-02-01');
  });
  it('styles every supported platform distinctly and keeps platform names available', () => {
    render(<ContestCalendarView contests={['leetcode', 'codeforces', 'atcoder', 'codechef'].map(p => event(p, day(21), day(21, 11), p as UpcomingContest['platform']))} initialDate={day(21)} />);
    expect(screen.getByRole('button', { name: /Round leetcode,/ }).className).toContain('orange');
    expect(screen.getByRole('button', { name: /Round codeforces,/ }).className).toContain('blue');
    expect(screen.getByRole('button', { name: /Round atcoder,/ }).className).toContain('red');
    expect(screen.getByRole('list', { name: 'Platform colors' }).textContent).toContain('CodeChef');
  });
  it('marks only overlapping events and names the collision pair', () => {
    render(<ContestCalendarView contests={[event('a'), event('b', day(21, 10, 30), day(21, 11, 30)), event('c', day(21, 11, 30), day(21, 12))]} initialDate={day(21)} />);
    expect(screen.getByRole('region', { name: 'Overlapping contests' }).textContent).toContain('Round a / Round b');
    expect(screen.getByRole('button', { name: /Round a,.*overlaps another/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Round c,/ }).getAttribute('aria-label')).not.toContain('overlaps');
  });
  it('opens named event details, traps focus, and restores the event after Escape', async () => {
    render(<ContestCalendarView contests={[event('a')]} initialDate={day(21)} />);
    const opener = screen.getByRole('button', { name: /Round a,/ }); opener.focus(); fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Round a' }); expect(dialog.getAttribute('aria-modal')).toBe('true');
    const close = within(dialog).getByRole('button', { name: 'Close dialog' }); const reminder = within(dialog).getByRole('button', { name: /Download 15-minute reminder/ });
    expect(document.activeElement).toBe(close); close.focus(); fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(reminder);
    fireEvent.keyDown(document, { key: 'Tab' }); expect(document.activeElement).toBe(close);
    expect(within(dialog).getByRole('link', { name: 'Contest details' }).getAttribute('href')).toBe('https://example.com/contest/a');
    expect(within(dialog).getByRole('link', { name: 'Add to Google Calendar' }).getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.keyDown(document, { key: 'Escape' }); await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  it('supports week switching and date navigation without changing the contest feed', () => {
    const { container } = render(<ContestCalendarView contests={[event('a')]} initialDate={day(21)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(container.querySelectorAll('td[data-date]')).toHaveLength(7); expect(container.querySelector('td')?.getAttribute('data-date')).toBe('2024-02-19');
    fireEvent.click(screen.getByRole('button', { name: 'Next week' })); expect(container.querySelector('td')?.getAttribute('data-date')).toBe('2024-02-26');
    expect(screen.queryByRole('button', { name: /Round a,/ })).toBeNull(); fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(screen.getByRole('button', { name: /Round a,/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Month' })); fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'March 2024' })).toBeTruthy();
  });
  it('places multi-day events on every intersected day and excludes an exact end day', () => {
    const { container } = render(<ContestCalendarView contests={[event('overnight', day(21, 23), day(23, 0))]} initialDate={day(21)} />);
    expect(container.querySelectorAll('[data-contest-key="leetcode:overnight"]')).toHaveLength(2);
    expect(container.querySelector('[data-date="2024-02-22"]')?.textContent).toContain('Continues');
    expect(container.querySelector('[data-date="2024-02-23"] [data-contest-key]')).toBeNull();
  });
  it('retains a complete empty calendar and responds to filter changes', () => {
    const { rerender, container } = render(<ContestCalendarView contests={[]} initialDate={day(21)} />);
    expect(screen.getByText(/No contests in this period/)).toBeTruthy(); expect(container.querySelectorAll('td[data-date]')).toHaveLength(35);
    rerender(<ContestCalendarView contests={[event('a')]} initialDate={day(21)} />);
    expect(screen.queryByText(/No contests in this period/)).toBeNull(); expect(screen.getByRole('button', { name: /Round a,/ })).toBeTruthy();
  });
  it('keeps cached schedules explicit and never renders an unsafe event link', () => {
    render(<ContestCalendarView contests={[{ ...event('a'), stale: true, url: 'javascript:alert(1)' }]} initialDate={day(21)} />);
    fireEvent.click(screen.getByRole('button', { name: /Round a,/ }));
    const dialog = screen.getByRole('dialog'); expect(within(dialog).getByText(/Cached schedule/)).toBeTruthy();
    expect(within(dialog).getByText('Contest link unavailable.')).toBeTruthy(); expect(within(dialog).queryAllByRole('link')).toHaveLength(0);
  });
  it('downloads a single-event reminder and revokes the temporary Blob URL', () => {
    const create = vi.fn<(blob: Blob) => string>().mockReturnValue('blob:calendar-test'); const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<ContestCalendarView contests={[event('a')]} initialDate={day(21)} />);
    fireEvent.click(screen.getByRole('button', { name: /Round a,/ })); fireEvent.click(screen.getByRole('button', { name: /Download 15-minute reminder/ }));
    expect(create).toHaveBeenCalledOnce(); expect(create.mock.calls[0][0].type).toBe('text/calendar;charset=utf-8');
    expect(click).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:calendar-test');
  });
});
