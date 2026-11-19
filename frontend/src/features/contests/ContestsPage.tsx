import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ExternalLink, Search, Trophy } from 'lucide-react';
import { PageShell } from '../../components/layout/PageShell';
import { ContestCountdown } from './ContestCountdown';
import { CalendarActions } from './CalendarActions';
import { PlatformFilterChips } from './PlatformFilterChips';
import { getUpcomingContests } from '../../services/contestsService';
import type { ContestPlatform } from './contestsUtils';
import { ContestCalendarView } from './components/ContestCalendarView';

const ALL_PLATFORMS: ContestPlatform[] = ['leetcode', 'codeforces', 'atcoder', 'codechef'];

const PLATFORM_LABELS: Record<ContestPlatform, string> = {
  leetcode: 'LeetCode',
  codeforces: 'Codeforces',
  atcoder: 'AtCoder',
  codechef: 'CodeChef',
};

export default function ContestsPage() {
  const [selectedPlatforms, setSelectedPlatforms] = useState<ContestPlatform[]>(ALL_PLATFORMS);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const { data: contests = [], isPending, isError, error, refetch } = useQuery({
    queryKey: ['contests', 'upcoming'],
    queryFn: ({ signal }) => getUpcomingContests(undefined, { signal }),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

  const filteredContests = useMemo(() => contests.filter((contest) => {
    const matchesPlatform = selectedPlatforms.includes(contest.platform);
    const query = search.trim().toLocaleLowerCase();
    const matchesSearch = !query
      || contest.contestName.toLocaleLowerCase().includes(query)
      || PLATFORM_LABELS[contest.platform].toLocaleLowerCase().includes(query);
    return matchesPlatform && matchesSearch;
  }), [contests, selectedPlatforms, search]);

  return (
    <PageShell
      title="Contest Hub"
      subtitle="Upcoming programming contests across your platforms"
      status={isError ? 'error' : isPending ? 'loading' : 'success'}
      error={isError ? (error instanceof Error ? error.message : 'Unable to load upcoming contests.') : null}
      onRetry={() => void refetch()}
    >
      <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 pb-12">
        <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="mb-2 flex items-center gap-2 text-[#7C5CFF]">
                <CalendarDays size={18} aria-hidden="true" />
                <span className="text-xs font-bold uppercase tracking-wider">Calendar tools</span>
              </div>
              <h2 className="text-lg font-semibold text-zinc-900">Plan your next contest</h2>
              <p className="mt-1 text-sm text-zinc-500">Add the next event to Google Calendar or export the list to your calendar app.</p>
            </div>
            <CalendarActions contests={filteredContests} />
          </div>
        </section>

        <section className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-base font-semibold text-zinc-900">Upcoming contests</h2>
              <p className="mt-1 text-sm text-zinc-500">{filteredContests.length} events match your filters</p>
            </div>
            <label className="relative block w-full sm:max-w-xs">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
              <span className="sr-only">Search contests</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search contests or platforms"
                className="w-full rounded-xl border border-zinc-200 bg-white py-2.5 pl-9 pr-3 text-sm text-zinc-900 outline-none transition focus:border-[#7C5CFF] focus:ring-2 focus:ring-[#7C5CFF]/15"
              />
            </label>
          </div>
          <PlatformFilterChips selected={selectedPlatforms} onChange={setSelectedPlatforms} />
          <div role="group" aria-label="Contest view" className="flex gap-2">
            {(['list', 'calendar'] as const).map(value => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} className={`rounded-lg border px-3 py-2 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${view === value ? 'border-violet-600 bg-violet-50 text-violet-900' : 'border-zinc-300 bg-white text-zinc-700'}`}>{value === 'list' ? 'List' : 'Calendar'}</button>)}
          </div>
        </section>

        {isPending && <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500">Loading upcoming contests…</div>}

        {!isPending && !isError && view === 'list' && filteredContests.length === 0 && (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white p-10 text-center">
            <Trophy size={28} className="mx-auto text-zinc-400" aria-hidden="true" />
            <h3 className="mt-3 font-semibold text-zinc-800">No matching contests</h3>
            <p className="mt-1 text-sm text-zinc-500">Try another platform or clear your search.</p>
          </div>
        )}

        {!isPending && !isError && view === 'calendar' && <ContestCalendarView contests={filteredContests} />}

        {view === 'list' && <div className="grid gap-3">
          {filteredContests.map((contest) => (
            <article key={`${contest.platform}:${contest.externalId}`} className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-[#7C5CFF]/30 hover:shadow-md">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-[#7C5CFF]/10 px-2.5 py-1 text-[11px] font-semibold text-[#5B3DF5]">{PLATFORM_LABELS[contest.platform]}</span>
                    {contest.stale && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">Cached data</span>}
                  </div>
                  <h3 className="truncate text-base font-semibold text-zinc-900">{contest.contestName}</h3>
                  <p className="mt-1 text-sm text-zinc-500">{new Date(contest.startTime).toLocaleString()} · {Math.round(contest.durationSeconds / 60)} min</p>
                </div>
                <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                  <ContestCountdown startTime={contest.startTime} endTime={contest.endTime} />
                  <a href={contest.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-[#5B3DF5] hover:underline">
                    Contest details <ExternalLink size={13} aria-hidden="true" />
                  </a>
                </div>
              </div>
            </article>
          ))}
        </div>}
      </div>
    </PageShell>
  );
}
