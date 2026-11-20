import { useEffect, useState, useMemo, type FC, type MouseEvent } from 'react';
import {
  Bell,
  BellRing,
  Calendar,
  Clock,
  ExternalLink,
  Radio,
  Trophy,
} from 'lucide-react';
import {
  buildGoogleCalendarUrl,
  getCountdownParts,
  type UpcomingContest,
  type ContestPlatform,
} from '../contestsUtils';

export interface ContestCardProps {
  contest: UpcomingContest;
  isReminderSet?: boolean;
  onToggleReminder?: (contest: UpcomingContest) => void;
  className?: string;
}

const PLATFORM_DETAILS: Record<
  ContestPlatform,
  {
    name: string;
    badgeStyle: string;
    borderAccent: string;
    brandColor: string;
    initials: string;
  }
> = {
  leetcode: {
    name: 'LeetCode',
    badgeStyle: 'bg-amber-100 text-amber-800 border-amber-200',
    borderAccent: 'hover:border-amber-400/60',
    brandColor: '#F59E0B',
    initials: 'LC',
  },
  codeforces: {
    name: 'Codeforces',
    badgeStyle: 'bg-blue-100 text-blue-800 border-blue-200',
    borderAccent: 'hover:border-blue-400/60',
    brandColor: '#2563EB',
    initials: 'CF',
  },
  atcoder: {
    name: 'AtCoder',
    badgeStyle: 'bg-rose-100 text-rose-800 border-rose-200',
    borderAccent: 'hover:border-rose-400/60',
    brandColor: '#E11D48',
    initials: 'AC',
  },
  codechef: {
    name: 'CodeChef',
    badgeStyle: 'bg-orange-100 text-orange-800 border-orange-200',
    borderAccent: 'hover:border-orange-400/60',
    brandColor: '#EA580C',
    initials: 'CC',
  },
};

/**
 * Extracts or infers contest difficulty / tier badge from contest name or metadata
 */
function inferDifficulty(contest: UpcomingContest): string {
  const name = contest.contestName;
  if (/div\.\s*1\b/i.test(name)) return 'Div. 1';
  if (/div\.\s*2\b/i.test(name)) return 'Div. 2';
  if (/div\.\s*3\b/i.test(name)) return 'Div. 3';
  if (/div\.\s*4\b/i.test(name)) return 'Div. 4';
  if (/biweekly/i.test(name)) return 'Biweekly';
  if (/weekly/i.test(name)) return 'Weekly';
  if (/beginner/i.test(name)) return 'Beginner';
  if (/grand/i.test(name)) return 'Grand';
  if (/starters/i.test(name)) return 'Starters';
  if (/educational/i.test(name)) return 'Educational';
  return 'Rated';
}

/**
 * Formats duration in seconds to human-readable string
 */
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`;
  return `${minutes} mins`;
}

/**
 * Formats date to local user timezone
 */
function formatLocalTime(isoDate: string): { dateStr: string; timeStr: string; timezoneStr: string } {
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) {
    return { dateStr: 'TBD', timeStr: 'TBD', timezoneStr: '' };
  }

  const dateStr = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  const timezoneStr = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return { dateStr, timeStr, timezoneStr };
}

export const ContestCard: FC<ContestCardProps> = ({
  contest,
  isReminderSet = false,
  onToggleReminder,
  className = '',
}) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const countdown = useMemo(
    () => getCountdownParts(contest.startTime, contest.endTime, now),
    [contest.startTime, contest.endTime, now]
  );

  const platformInfo = PLATFORM_DETAILS[contest.platform] || {
    name: contest.platform,
    badgeStyle: 'bg-zinc-100 text-zinc-800 border-zinc-200',
    borderAccent: 'hover:border-zinc-400/60',
    brandColor: '#4F46E5',
    initials: contest.platform.substring(0, 2).toUpperCase(),
  };

  const difficulty = inferDifficulty(contest);
  const durationText = formatDuration(contest.durationSeconds);
  const { dateStr, timeStr } = formatLocalTime(contest.startTime);

  const isLive = countdown.state === 'live';
  const isEnded = countdown.state === 'ended';

  const countdownText = useMemo(() => {
    if (isLive) return 'Live Now';
    if (isEnded) return 'Ended';

    const { days, hours, minutes, seconds } = countdown;
    if (days > 0) {
      return `Starts in ${days}d ${hours}h ${minutes}m`;
    }
    return `Starts in ${hours}h ${minutes}m ${seconds}s`;
  }, [countdown, isLive, isEnded]);

  const handleReminderClick = (e: MouseEvent) => {
    e.preventDefault();
    if (onToggleReminder) {
      onToggleReminder(contest);
    }
  };

  return (
    <article
      data-testid="contest-card"
      data-platform={contest.platform}
      data-state={countdown.state}
      aria-label={`${contest.contestName} on ${platformInfo.name}`}
      className={[
        'group relative flex flex-col justify-between rounded-2xl border border-zinc-200/90 bg-white p-5 shadow-sm transition-all duration-200 hover:shadow-md',
        platformInfo.borderAccent,
        isLive ? 'ring-2 ring-emerald-500/30' : '',
        className,
      ].join(' ')}
    >
      {/* Top Header: Platform logo/badge & Difficulty / Status */}
      <div>
        <div className="flex items-center justify-between gap-2">
          {/* Platform Badge with logo indicator */}
          <div className="flex items-center gap-2">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-lg font-mono text-xs font-black text-white shadow-xs"
              style={{ backgroundColor: platformInfo.brandColor }}
              aria-hidden="true"
            >
              {platformInfo.initials}
            </span>
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${platformInfo.badgeStyle}`}
            >
              {platformInfo.name}
            </span>
            {contest.stale && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                Cached
              </span>
            )}
          </div>

          {/* Difficulty & Status Badge */}
          <div className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-[11px] font-semibold text-zinc-700">
              <Trophy size={11} className="text-zinc-500" aria-hidden="true" />
              {difficulty}
            </span>
            {isLive ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-800 animate-pulse"
                aria-live="polite"
              >
                <Radio size={12} className="text-emerald-600 animate-spin" aria-hidden="true" />
                Live Now
              </span>
            ) : isEnded ? (
              <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500">
                Ended
              </span>
            ) : (
              <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                Upcoming
              </span>
            )}
          </div>
        </div>

        {/* Contest Title */}
        <h3 className="mt-3 line-clamp-2 text-base font-semibold leading-snug text-zinc-900 group-hover:text-[#7C5CFF] transition-colors">
          <a
            href={contest.url}
            target="_blank"
            rel="noopener noreferrer"
            className="focus:outline-none focus:underline"
            title={contest.contestName}
          >
            {contest.contestName}
          </a>
        </h3>

        {/* Schedule & Duration Information */}
        <div className="mt-3 space-y-1.5 text-xs text-zinc-600">
          <div className="flex items-center gap-1.5">
            <Calendar size={13} className="text-zinc-400 shrink-0" aria-hidden="true" />
            <span className="font-medium text-zinc-800">
              {dateStr} at {timeStr}
            </span>
            <span className="text-zinc-400 font-normal">(local)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock size={13} className="text-zinc-400 shrink-0" aria-hidden="true" />
            <span>Duration: {durationText}</span>
          </div>
        </div>

        {/* Live Countdown in local timezone */}
        <div className="mt-4 rounded-xl border border-zinc-100 bg-zinc-50/80 px-3 py-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-zinc-500">Countdown:</span>
            <span
              data-testid="contest-countdown"
              className={`font-mono text-xs font-semibold tabular-nums ${
                isLive
                  ? 'text-emerald-700 font-bold'
                  : isEnded
                  ? 'text-zinc-400'
                  : 'text-[#5B3DF5]'
              }`}
              aria-live={isLive ? 'polite' : 'off'}
            >
              {countdownText}
            </span>
          </div>
        </div>
      </div>

      {/* Card Footer: Reminder Toggle & Calendar / Contest Actions */}
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-zinc-100 pt-3">
        {/* Set Reminder Button */}
        <button
          type="button"
          onClick={handleReminderClick}
          aria-pressed={isReminderSet}
          aria-label={
            isReminderSet
              ? `Remove reminder for ${contest.contestName}`
              : `Set reminder for ${contest.contestName}`
          }
          className={[
            'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C5CFF]',
            isReminderSet
              ? 'border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
              : 'border border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50',
          ].join(' ')}
        >
          {isReminderSet ? (
            <>
              <BellRing size={14} className="text-emerald-600 animate-bounce" aria-hidden="true" />
              <span>Reminder Set</span>
            </>
          ) : (
            <>
              <Bell size={14} className="text-zinc-500" aria-hidden="true" />
              <span>Set Reminder</span>
            </>
          )}
        </button>

        {/* External Link & Quick Calendar Button */}
        <div className="flex items-center gap-1.5">
          <a
            href={buildGoogleCalendarUrl(contest)}
            target="_blank"
            rel="noopener noreferrer"
            title="Add to Google Calendar"
            aria-label={`Add ${contest.contestName} to Google Calendar`}
            className="inline-flex items-center justify-center rounded-lg border border-zinc-200 bg-white p-1.5 text-zinc-500 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C5CFF]"
          >
            <Calendar size={14} aria-hidden="true" />
          </a>
          <a
            href={contest.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open contest link"
            aria-label={`View contest details for ${contest.contestName}`}
            className="inline-flex items-center gap-1 rounded-lg bg-[#7C5CFF]/10 px-2.5 py-1.5 text-xs font-semibold text-[#5B3DF5] transition-colors hover:bg-[#7C5CFF]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C5CFF]"
          >
            <span>Details</span>
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      </div>
    </article>
  );
};
