import { useMemo, useState } from 'react';
import { CalendarPlus, ChevronLeft, ChevronRight, Download, ExternalLink, TriangleAlert } from 'lucide-react';
import { Modal } from '../../../components/ui/Modal';
import { cn } from '../../../lib/design-system/tokens.css';
import { buildGoogleCalendarUrl, type ContestPlatform, type UpcomingContest } from '../contestsUtils';
import { calendarContests, calendarDays, contestCollisions, contestReminderIcs, contestsOnDay, localDateKey, safeContestUrl, type CalendarMode } from '../contestCalendar';
import { ContestCollisionBanner } from './ContestCollisionBanner';

const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const platformNames: Record<ContestPlatform, string> = { leetcode: 'LeetCode', codeforces: 'Codeforces', atcoder: 'AtCoder', codechef: 'CodeChef' };
const platformStyles: Record<ContestPlatform, string> = {
  leetcode: 'border-orange-300 bg-orange-50 text-orange-950',
  codeforces: 'border-blue-300 bg-blue-50 text-blue-950',
  atcoder: 'border-l-red-600 border-zinc-800 bg-zinc-900 text-white',
  codechef: 'border-stone-400 bg-stone-100 text-stone-900',
};
const control = 'rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600';
const time = (value: number) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fullDate = (value: Date) => value.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

interface ContestCalendarViewProps { contests: UpcomingContest[]; initialDate?: Date }

export function ContestCalendarView({ contests, initialDate }: ContestCalendarViewProps) {
  const [anchor, setAnchor] = useState(() => new Date(initialDate?.getTime() ?? Date.now()));
  const [mode, setMode] = useState<CalendarMode>('month');
  const [selected, setSelected] = useState<UpcomingContest | null>(null);
  const entries = useMemo(() => calendarContests(contests), [contests]);
  const days = useMemo(() => calendarDays(anchor, mode), [anchor, mode]);
  const first = days[0].getTime();
  const last = new Date(days[days.length - 1].getFullYear(), days[days.length - 1].getMonth(), days[days.length - 1].getDate() + 1).getTime();
  const visible = useMemo(() => entries.filter(event => event.start < last && event.end > first), [entries, first, last]);
  const collisions = useMemo(() => contestCollisions(visible), [visible]);
  const heading = mode === 'month'
    ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : `${days[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} – ${days[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const today = localDateKey(new Date());
  const selectedUrl = selected ? safeContestUrl(selected.url) : undefined;
  function navigate(direction: number) {
    setSelected(null);
    setAnchor(current => mode === 'month'
      ? new Date(current.getFullYear(), current.getMonth() + direction, 1)
      : new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7 * direction));
  }
  function downloadReminder() {
    if (!selected) return;
    const url = URL.createObjectURL(new Blob([contestReminderIcs(selected)], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'devtrack-contest-reminder.ics';
    document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }
  return (
    <section aria-label="Contest calendar" className="min-w-0 space-y-4 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold text-zinc-900" aria-live="polite">{heading}</h2><p className="mt-1 text-xs text-zinc-500">Times in {Intl.DateTimeFormat().resolvedOptions().timeZone}. Weeks start on Monday.</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={control} onClick={() => navigate(-1)} aria-label={`Previous ${mode}`}><ChevronLeft size={16} aria-hidden="true" /></button>
          <button type="button" className={control} onClick={() => { setSelected(null); setAnchor(new Date()); }}>Today</button>
          <button type="button" className={control} onClick={() => navigate(1)} aria-label={`Next ${mode}`}><ChevronRight size={16} aria-hidden="true" /></button>
          <div role="group" aria-label="Calendar period" className="flex gap-1">
            {(['month', 'week'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} className={cn(control, mode === value && 'border-violet-600 bg-violet-50 text-violet-900')} onClick={() => { setSelected(null); setMode(value); }}>{value === 'month' ? 'Month' : 'Week'}</button>)}
          </div>
        </div>
      </div>
      <ul aria-label="Platform colors" className="flex flex-wrap gap-2 text-[11px] font-semibold">
        {Object.entries(platformNames).map(([platform, label]) => <li key={platform} className={`rounded border px-2 py-1 ${platformStyles[platform as ContestPlatform]}`}>{label}</li>)}
      </ul>
      <ContestCollisionBanner collisions={collisions} />
      {entries.length < contests.length && <p role="status" className="text-xs text-amber-800">Some duplicate or invalid events were omitted.</p>}
      {visible.length === 0 && <p role="status" className="rounded-lg bg-zinc-50 p-3 text-sm text-zinc-600">No contests in this period. Change the date or your platform filters.</p>}
      <div role="region" aria-label="Calendar days; scroll horizontally on smaller screens" tabIndex={0} className="relative max-w-full overflow-x-auto rounded-xl border border-zinc-200 focus-visible:outline-2 focus-visible:outline-violet-600">
        <table className="w-full min-w-[700px] table-fixed border-collapse text-left">
          <caption className="sr-only">{mode === 'month' ? 'Monthly' : 'Weekly'} contest schedule for {heading}</caption>
          <thead><tr>{weekdays.map(day => <th scope="col" key={day} className="border-b border-zinc-200 bg-zinc-50 px-2 py-3 text-xs font-semibold text-zinc-600"><abbr title={day} className="no-underline">{day.slice(0, 3)}</abbr></th>)}</tr></thead>
          <tbody>{Array.from({ length: days.length / 7 }, (_, row) => <tr key={localDateKey(days[row * 7])}>
            {days.slice(row * 7, row * 7 + 7).map(day => {
              const key = localDateKey(day); const items = contestsOnDay(visible, day);
              return <td key={key} data-date={key} className={`h-32 border-b border-r border-zinc-200 p-2 align-top ${mode === 'month' && day.getMonth() !== anchor.getMonth() ? 'bg-zinc-50' : 'bg-white'}`}>
                <time dateTime={key} aria-current={key === today ? 'date' : undefined} className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs ${key === today ? 'bg-violet-700 font-bold text-white' : 'text-zinc-600'}`}><span className="sr-only">{fullDate(day)}</span><span aria-hidden="true">{day.getDate()}</span></time>
                <div className="mt-2 space-y-1.5">{items.map(event => <button type="button" key={event.key} data-contest-key={event.key} onClick={() => setSelected(event.contest)}
                  aria-label={`${event.contest.contestName}, ${new Date(event.start).toLocaleString()}${collisions.keys.has(event.key) ? ', overlaps another contest' : ''}`}
                  className={`block w-full rounded-md border border-l-[3px] p-1.5 text-left text-[11px] leading-snug focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 ${platformStyles[event.contest.platform]}`}>
                  <span className="flex items-center justify-between gap-1"><span>{event.start < day.getTime() ? 'Continues' : time(event.start)}</span>{collisions.keys.has(event.key) && <TriangleAlert size={12} aria-label="Overlapping contest" />}</span>
                  <span className="mt-1 block break-words font-semibold">{event.contest.contestName}</span><span className="sr-only">{platformNames[event.contest.platform]}</span>
                  {event.contest.stale && <span className="mt-1 block">Cached data</span>}
                </button>)}</div>
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
      <Modal open={selected !== null} onClose={() => setSelected(null)} title={selected?.contestName} description={selected ? `${platformNames[selected.platform]} contest details` : undefined}>
        {selected && <div className="space-y-4 text-sm text-zinc-700">
          <dl className="space-y-2"><div><dt className="font-semibold">Starts</dt><dd>{new Date(selected.startTime).toLocaleString()}</dd></div><div><dt className="font-semibold">Ends</dt><dd>{new Date(selected.endTime).toLocaleString()}</dd></div><div><dt className="font-semibold">Timezone</dt><dd>{Intl.DateTimeFormat().resolvedOptions().timeZone}</dd></div></dl>
          {selected.stale && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">Cached schedule. Confirm the latest details with the contest host.</p>}
          {selectedUrl ? <div className="flex flex-wrap gap-3"><a href={selectedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-violet-700 underline">Contest details <ExternalLink size={14} aria-hidden="true" /></a><a href={buildGoogleCalendarUrl({ ...selected, url: selectedUrl })} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-violet-700 underline"><CalendarPlus size={14} aria-hidden="true" /> Add to Google Calendar</a></div> : <p>Contest link unavailable.</p>}
          <button type="button" onClick={downloadReminder} className={`${control} inline-flex items-center gap-2`}><Download size={15} aria-hidden="true" /> Download 15-minute reminder (.ics)</button>
          <p className="text-xs text-zinc-500">Import the file into your calendar app to enable its reminder. DevTrack does not create a browser notification from this action.</p>
        </div>}
      </Modal>
    </section>
  );
}
