import { useEffect, useState } from 'react';
import { getCountdownParts } from './contestsUtils';

interface ContestCountdownProps {
  startTime: string;
  endTime: string;
}

export function ContestCountdown({ startTime, endTime }: ContestCountdownProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const countdown = getCountdownParts(startTime, endTime, now);

  if (countdown.state === 'live') {
    return <span className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-700" aria-live="polite">
      <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" /> Live Now
    </span>;
  }

  if (countdown.state === 'ended') {
    return <span className="text-xs font-medium text-zinc-500">Ended</span>;
  }

  return (
    <span className="font-mono text-xs font-semibold tabular-nums text-[#475467]" aria-live="off">
      {countdown.days > 0 && `${countdown.days}d `}
      {String(countdown.hours).padStart(2, '0')}h{' '}
      {String(countdown.minutes).padStart(2, '0')}m{' '}
      {String(countdown.seconds).padStart(2, '0')}s
    </span>
  );
}
