import { CalendarPlus, Download } from 'lucide-react';
import { buildGoogleCalendarUrl, buildIcsContent, type UpcomingContest } from './contestsUtils';

interface CalendarActionsProps {
  contests: UpcomingContest[];
}

export function CalendarActions({ contests }: CalendarActionsProps) {
  const downloadCalendar = () => {
    const content = buildIcsContent(contests);
    const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'devtrack-contests.ics';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const nextContest = contests[0];

  return (
    <div className="flex flex-wrap gap-2">
      <a
        href={nextContest ? buildGoogleCalendarUrl(nextContest) : undefined}
        target="_blank"
        rel="noopener noreferrer"
        aria-disabled={!nextContest}
        className={[
          'inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors',
          nextContest
            ? 'bg-[#7C5CFF] text-white hover:bg-[#6D4DFF]'
            : 'pointer-events-none bg-zinc-100 text-zinc-400',
        ].join(' ')}
      >
        <CalendarPlus size={16} aria-hidden="true" />
        Add next to Google Calendar
      </a>
      <button
        type="button"
        onClick={downloadCalendar}
        disabled={contests.length === 0}
        className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Download size={16} aria-hidden="true" />
        Download .ics
      </button>
    </div>
  );
}
