import React, { useEffect, useState } from 'react';
import { History, Flame, CheckCircle, ChevronRight } from 'lucide-react';
import { focusService, type FocusSummary } from '../services/focusService';

interface FocusTodayCompactProps {
  onOpenHistory: () => void;
  summary?: FocusSummary | null;
}

export const FocusTodayCompact: React.FC<FocusTodayCompactProps> = ({
  onOpenHistory,
  summary: externalSummary,
}) => {
  const [summary, setSummary] = useState<FocusSummary>({
    todayMinutes: 50,
    targetMinutes: 120,
    completedSessionsToday: 2,
    currentStreak: 4,
  });

  useEffect(() => {
    if (externalSummary) {
      setSummary(externalSummary);
      return;
    }
    focusService.getTodaySummary().then(setSummary);
  }, [externalSummary]);

  const percentage = Math.min(100, Math.round((summary.todayMinutes / (summary.targetMinutes || 120)) * 100));
  const strokeDashoffset = 100 - percentage;

  return (
    <div className="w-full bg-white dark:bg-[#121217] border border-zinc-200 dark:border-zinc-800/80 rounded-3xl p-5 sm:p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
        {/* Left: Progress Ring + Stats */}
        <div className="flex items-center gap-5 w-full sm:w-auto">
          {/* Circular Progress Ring */}
          <div className="relative w-20 h-20 flex-shrink-0 flex items-center justify-center">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 36 36">
              {/* Background Ring */}
              <path
                className="text-zinc-100 dark:text-zinc-800/80"
                strokeWidth="3.5"
                stroke="currentColor"
                fill="none"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
              {/* Progress Ring */}
              <path
                className="text-emerald-500 transition-all duration-1000 ease-out"
                strokeDasharray="100, 100"
                strokeDashoffset={strokeDashoffset}
                strokeWidth="3.5"
                strokeLinecap="round"
                stroke="currentColor"
                fill="none"
                d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              />
            </svg>
            <div className="absolute flex flex-col items-center justify-center">
              <span className="text-base font-extrabold tracking-tight">{percentage}%</span>
            </div>
          </div>

          {/* Metrics Overview */}
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 rounded-full">
                Today's Focus
              </span>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">•</span>
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Target: {summary.targetMinutes}m</span>
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-2xl font-black tracking-tight">{summary.todayMinutes}</span>
              <span className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">minutes active</span>
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
