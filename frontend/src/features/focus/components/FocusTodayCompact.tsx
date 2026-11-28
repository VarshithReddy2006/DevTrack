import React, { useEffect, useState } from 'react';
import { History, Flame, CheckCircle, ChevronRight, Timer } from 'lucide-react';
import { focusService, type FocusSummary } from '../services/focusService';

interface FocusTodayCompactProps {
  onOpenHistory: () => void;
  summary?: FocusSummary | null;
  /** Change this to load the summary again, for example after a session ends. */
  refreshKey?: unknown;
}

export const FocusTodayCompact: React.FC<FocusTodayCompactProps> = ({
  onOpenHistory,
  summary: externalSummary,
  refreshKey,
}) => {
  const [loadedSummary, setLoadedSummary] = useState<FocusSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const summary = externalSummary ?? loadedSummary;

  useEffect(() => {
    if (externalSummary) return;
    let current = true;
    setFailed(false);
    focusService.getTodaySummary()
      .then((next) => { if (current) setLoadedSummary(next); })
      .catch(() => {
        if (!current) return;
        setLoadedSummary(null);
        setFailed(true);
      });
    return () => { current = false; };
  }, [externalSummary, refreshKey, attempt]);

  return (
    <div className="w-full bg-white dark:bg-[#121217] border border-zinc-200 dark:border-zinc-800/80 rounded-3xl p-5 sm:p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
        {/* Left: Today's totals */}
        <div className="flex items-center gap-5 w-full sm:w-auto">
          <div className="w-20 h-20 flex-shrink-0 flex items-center justify-center rounded-full bg-emerald-500/10">
            <Timer className="w-8 h-8 text-emerald-500" />
          </div>

          {/* Metrics Overview */}
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 rounded-full">
                Today's Focus
              </span>
            </div>
            {summary ? (
              <>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-2xl font-black tracking-tight">{summary.todayMinutes}</span>
                  <span className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">minutes completed</span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="flex items-center gap-1">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                    {summary.completedSessionsToday} sprints completed
                  </span>
                  <span className="flex items-center gap-1 text-orange-500 font-medium">
                    <Flame className="w-3.5 h-3.5" />
                    {summary.currentStreak} day streak
                  </span>
                </div>
              </>
            ) : failed ? (
              <div role="alert" className="mt-2 flex items-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
                <span>Could not load today&apos;s focus.</span>
                <button type="button" onClick={() => setAttempt((n) => n + 1)} className="font-semibold underline">
                  Retry
                </button>
              </div>
            ) : (
              <p role="status" className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading today&apos;s focus…</p>
            )}
          </div>
        </div>

        {/* Right: History Drawer Trigger Button */}
        <button
          onClick={onOpenHistory}
          className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-3 rounded-2xl bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800/80 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 font-semibold text-sm transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] border border-zinc-200/80 dark:border-zinc-700/60"
        >
          <History className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
          <span>Focus History</span>
          <ChevronRight className="w-4 h-4 text-zinc-400" />
        </button>
      </div>
    </div>
  );
};
