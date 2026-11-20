import { useMemo, useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  CalendarDays,
  Globe,
  LayoutGrid,
  RotateCcw,
  Search,
  Trophy,
} from 'lucide-react';
import { PageShell } from '../../components/layout/PageShell';
import { getUpcomingContests } from '../../services/contestsService';
import {
  type UpcomingContest,
  getCountdownParts,
} from './contestsUtils';
import {
  PlatformFilterPills,
  type FilterPlatform,
} from './components/PlatformFilterPills';
import { ContestCard } from './components/ContestCard';
import { ContestCalendarView } from './components/ContestCalendarView';
import { CalendarActions } from './CalendarActions';
import {
  requestNotificationPermission,
  scheduleContestAlert,
} from './alerts/contestAlertScheduler';

export type ContestStatusFilter = 'all' | 'upcoming' | 'live' | 'ended';

const STORAGE_REMINDERS_KEY = 'devtrack_contest_reminders';

export default function ContestHubPage() {
  const [selectedPlatform, setSelectedPlatform] = useState<FilterPlatform>('all');
  const [selectedStatus, setSelectedStatus] = useState<ContestStatusFilter>('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'calendar'>('grid');
  const [showRemindersOnly, setShowRemindersOnly] = useState(false);
  const [savedReminders, setSavedReminders] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_REMINDERS_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Fetch contests using react-query
  const {
    data: contests = [],
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['contests', 'upcoming'],
    queryFn: ({ signal }) => getUpcomingContests(undefined, { signal }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  // Save reminders to localStorage whenever changed
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_REMINDERS_KEY, JSON.stringify(savedReminders));
    } catch {
      // localStorage might fail in restricted iframe / storage quotas
    }
  }, [savedReminders]);

  // Toggle reminder for a contest
  const handleToggleReminder = async (contest: UpcomingContest) => {
    const contestKey = `${contest.platform}:${contest.externalId}`;
    const isAlreadySet = savedReminders.includes(contestKey);

    if (isAlreadySet) {
      setSavedReminders((prev) => prev.filter((id) => id !== contestKey));
    } else {
      // Ask notification permission if possible
      try {
        await requestNotificationPermission();
      } catch {
        // Continue regardless
      }

      setSavedReminders((prev) => [...prev, contestKey]);

      // Schedule notification timer if upcoming
      scheduleContestAlert({
        id: contestKey,
        name: contest.contestName,
        platform: contest.platform,
        startTime: contest.startTime,
        url: contest.url,
      });
    }
  };

  // User's detected local timezone
  const localTimezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
    } catch {
      return 'Local';
    }
  }, []);

  // Compute platform counts
  const platformCounts = useMemo(() => {
    const counts: Partial<Record<FilterPlatform, number>> = {
      all: contests.length,
      leetcode: 0,
      codeforces: 0,
      atcoder: 0,
      codechef: 0,
    };
    for (const item of contests) {
      if (counts[item.platform] !== undefined) {
        counts[item.platform] = (counts[item.platform] ?? 0) + 1;
      }
    }
    return counts;
  }, [contests]);

  // Filtered contests
  const filteredContests = useMemo(() => {
    const now = Date.now();
    const query = search.trim().toLowerCase();

    return contests.filter((contest) => {
      // Platform filter
      if (selectedPlatform !== 'all' && contest.platform !== selectedPlatform) {
        return false;
      }

      // Reminders only filter
      const contestKey = `${contest.platform}:${contest.externalId}`;
      if (showRemindersOnly && !savedReminders.includes(contestKey)) {
        return false;
      }

      // Status filter
      if (selectedStatus !== 'all') {
        const countdown = getCountdownParts(contest.startTime, contest.endTime, now);
        if (selectedStatus !== countdown.state) {
          return false;
        }
      }

      // Search filter
      if (query) {
        const nameMatches = contest.contestName.toLowerCase().includes(query);
        const platformMatches = contest.platform.toLowerCase().includes(query);
        if (!nameMatches && !platformMatches) {
          return false;
        }
      }

      return true;
    });
  }, [contests, selectedPlatform, selectedStatus, showRemindersOnly, savedReminders, search]);

  const resetFilters = () => {
    setSelectedPlatform('all');
    setSelectedStatus('all');
    setSearch('');
    setShowRemindersOnly(false);
  };

  const hasActiveFilters =
    selectedPlatform !== 'all' ||
    selectedStatus !== 'all' ||
    Boolean(search.trim()) ||
    showRemindersOnly;

  return (
    <PageShell
      title="Contest Hub"
      subtitle="Track upcoming competitive programming contests with live countdowns and smart reminders"
      status={isError ? 'error' : isPending ? 'loading' : 'success'}
      error={isError ? (error instanceof Error ? error.message : 'Unable to load upcoming contests.') : null}
      onRetry={() => void refetch()}
    >
      <div className="mx-auto flex w-full max-w-[1240px] flex-col gap-6 pb-16">
        {/* Top banner / Calendar Tools Section */}
        <section
          aria-label="Contest planner and calendar tools"
          className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6"
        >
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[#7C5CFF]">
                <CalendarDays size={18} aria-hidden="true" />
                <span className="text-xs font-bold uppercase tracking-wider">Contest Schedule Hub</span>
              </div>
              <h2 className="text-lg font-semibold text-zinc-900">Never miss another contest</h2>
              <p className="mt-1 text-sm text-zinc-500">
                All start times and live countdowns are synchronized to your browser timezone:
                <span className="ml-1.5 inline-flex items-center gap-1 font-medium text-zinc-800">
                  <Globe size={13} className="text-[#7C5CFF]" aria-hidden="true" />
                  {localTimezone}
                </span>
              </p>
            </div>
            <CalendarActions contests={filteredContests} />
          </div>
        </section>

        {/* Filter and Search Bar */}
        <section
          aria-label="Contest search and filters"
          className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6"
        >
          {/* Search and View Toggle Header */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <label className="relative block w-full sm:w-80">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
                  aria-hidden="true"
                />
                <span className="sr-only">Search contests</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search contests or platforms..."
                  className="w-full rounded-xl border border-zinc-200 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition focus:border-[#7C5CFF] focus:ring-2 focus:ring-[#7C5CFF]/15"
                />
              </label>

              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="inline-flex items-center gap-1 rounded-xl border border-zinc-200 px-3 py-2 text-xs font-semibold text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
                  title="Reset all filters"
                >
                  <RotateCcw size={13} aria-hidden="true" />
                  <span className="hidden sm:inline">Reset</span>
                </button>
              )}
            </div>

            {/* View Switch: Grid vs Calendar */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRemindersOnly(!showRemindersOnly)}
                aria-pressed={showRemindersOnly}
                className={[
                  'inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition-colors',
                  showRemindersOnly
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50',
                ].join(' ')}
              >
                <Bell size={14} className={showRemindersOnly ? 'text-emerald-600' : 'text-zinc-400'} aria-hidden="true" />
                <span>My Reminders</span>
                {savedReminders.length > 0 && (
                  <span className="ml-1 rounded-full bg-emerald-200 px-1.5 py-0.2 text-[10px] font-bold text-emerald-900">
                    {savedReminders.length}
                  </span>
                )}
              </button>

              <div role="group" aria-label="Contest view layout" className="flex rounded-xl border border-zinc-200 p-0.5">
                <button
                  type="button"
                  aria-pressed={view === 'grid'}
                  onClick={() => setView('grid')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                    view === 'grid'
                      ? 'bg-[#7C5CFF] text-white shadow-xs'
                      : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  <LayoutGrid size={14} aria-hidden="true" />
                  <span>Grid</span>
                </button>
                <button
                  type="button"
                  aria-pressed={view === 'calendar'}
                  onClick={() => setView('calendar')}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                    view === 'calendar'
                      ? 'bg-[#7C5CFF] text-white shadow-xs'
                      : 'text-zinc-600 hover:text-zinc-900'
                  }`}
                >
                  <CalendarDays size={14} aria-hidden="true" />
                  <span>Calendar</span>
                </button>
              </div>
            </div>
          </div>

          {/* Platform Filter Pills */}
          <div className="pt-1">
            <PlatformFilterPills
              selected={selectedPlatform}
              onChange={setSelectedPlatform}
              counts={platformCounts}
            />
          </div>

          {/* Status Filters: All, Upcoming, Live, Ended */}
          <div
            role="group"
            aria-label="Filter by contest status"
            className="flex flex-wrap items-center gap-1.5 pt-1 text-xs text-zinc-600"
          >
            <span className="mr-1 text-xs font-medium text-zinc-400">Status:</span>
            {(
              [
                { id: 'all', label: 'All Statuses' },
                { id: 'upcoming', label: 'Upcoming' },
                { id: 'live', label: 'Live Now' },
                { id: 'ended', label: 'Past Contests' },
              ] as const
            ).map(({ id, label }) => {
              const active = selectedStatus === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedStatus(id)}
                  className={[
                    'rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors',
                    active
                      ? 'bg-zinc-900 text-white'
                      : 'border border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50',
                  ].join(' ')}
                >
                  {label}
                </button>
              );
            })}
            <span className="ml-auto text-xs text-zinc-400">
              Showing {filteredContests.length} of {contests.length} contests
            </span>
          </div>
        </section>

        {/* Loading State */}
        {isPending && (
          <div className="rounded-2xl border border-zinc-200 bg-white p-12 text-center text-sm text-zinc-500">
            <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-[#7C5CFF] border-t-transparent mb-3" />
            Loading upcoming contests across platforms…
          </div>
        )}

        {/* Empty State */}
        {!isPending && !isError && filteredContests.length === 0 && (
          <div
            data-testid="empty-contests"
            className="rounded-2xl border border-dashed border-zinc-300 bg-white p-12 text-center"
          >
            <Trophy size={36} className="mx-auto text-zinc-300" aria-hidden="true" />
            <h3 className="mt-3 text-base font-semibold text-zinc-800">No matching contests found</h3>
            <p className="mt-1 text-sm text-zinc-500 max-w-sm mx-auto">
              We couldn't find any contests matching your current platform, status, or search filters.
            </p>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[#7C5CFF] px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-[#6D4DFF]"
              >
                <RotateCcw size={13} aria-hidden="true" />
                Reset filters
              </button>
            )}
          </div>
        )}

        {/* Calendar View */}
        {!isPending && !isError && view === 'calendar' && (
          <ContestCalendarView contests={filteredContests} />
        )}

        {/* Responsive Grid View */}
        {!isPending && !isError && view === 'grid' && filteredContests.length > 0 && (
          <div
            data-testid="contest-grid"
            className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3"
          >
            {filteredContests.map((contest) => {
              const contestKey = `${contest.platform}:${contest.externalId}`;
              const isReminderSet = savedReminders.includes(contestKey);
              return (
                <ContestCard
                  key={contestKey}
                  contest={contest}
                  isReminderSet={isReminderSet}
                  onToggleReminder={handleToggleReminder}
                />
              );
            })}
          </div>
        )}
      </div>
    </PageShell>
  );
}
