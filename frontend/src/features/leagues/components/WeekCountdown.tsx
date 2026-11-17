import { useEffect, useState } from 'react';
import { getCountdownParts } from '../leagueUtils';

interface WeekCountdownProps {
  /** ISO timestamp of the weekly rollover (Sunday 00:00 UTC). */
  resetsAt: string;
  /** Called once when the countdown reaches zero, so the caller can refetch the new week. */
  onExpire?: () => void;
}

export function WeekCountdown({ resetsAt, onExpire }: WeekCountdownProps) {
  const target = Date.parse(resetsAt);
  const [now, setNow] = useState(() => Date.now());
  const parts = getCountdownParts(target, now);

  useEffect(() => {
    if (parts.ended) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [parts.ended]);

  useEffect(() => {
    if (parts.ended) onExpire?.();
    // onExpire is deliberately left out: a new inline callback must not re-fire it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts.ended]);

  if (Number.isNaN(target)) return null;

  if (parts.ended) {
    return <span className="text-sm font-medium text-zinc-600">Week ended, new standings are being set up</span>;
  }

  const text = `${parts.days}d ${parts.hours}h ${parts.minutes}m`;
  return (
    <span className="text-sm text-zinc-600">
      Week resets in{' '}
      <time dateTime={resetsAt} className="font-mono font-semibold tabular-nums text-zinc-900" title={`Resets ${new Date(target).toUTCString()}`}>
        {text}
      </time>
    </span>
  );
}
