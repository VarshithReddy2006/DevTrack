import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Clock, Award, Calendar } from 'lucide-react';
import { focusService, type FocusHistoryItem } from '../services/focusService';

interface FocusHistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const FocusHistoryDrawer: React.FC<FocusHistoryDrawerProps> = ({
  isOpen,
  onClose,
}) => {
  const [history, setHistory] = useState<FocusHistoryItem[]>([]);
  const [filter, setFilter] = useState<'all' | 'completed'>('all');
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    focusService.getHistory(30).then((items) => {
      setHistory(items ?? []);
      setLoading(false);
    });
  }, [isOpen]);

  const filtered = history.filter((item) =>
    filter === 'all' ? true : item.status === 'completed'
  );

  const formatSessionDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoStr;
    }
  };

  const getModeLabel = (mode: string) => {
    switch (mode) {
      case 'deep_work': return 'Deep Work';
      case 'backend': return 'Backend Build';
      case 'dsa': return 'DSA Sprint';
      case 'debug': return 'Debugging';
      case 'learn': return 'Learning';
      case 'arch': return 'Architecture';
      default: return mode.replace('_', ' ');
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 overflow-hidden">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        />

        {/* Slide-over Container */}
        <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="w-screen max-w-md bg-white dark:bg-[#121217] border-l border-zinc-200 dark:border-zinc-800 shadow-2xl flex flex-col text-zinc-900 dark:text-zinc-100"
          >
            {/* Drawer Header */}
            <div className="p-6 border-b border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold tracking-tight">Focus History</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                  Recent sessions &amp; XP breakdown
                </p>
              </div>
              <button
                onClick={onClose}
                className="p-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                aria-label="Close drawer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filter Tabs */}
            <div className="px-6 py-3 border-b border-zinc-100 dark:border-zinc-800/80 flex items-center gap-2">
              <button
                onClick={() => setFilter('all')}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                  filter === 'all'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                All ({history.length})
              </button>
              <button
                onClick={() => setFilter('completed')}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                  filter === 'completed'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                Completed ({history.filter(h => h.status === 'completed').length})
              </button>
            </div>

            {/* Session List */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {loading ? (
                <div className="flex items-center justify-center py-20 text-zinc-400 text-sm">
                  Loading history…
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-center text-zinc-400">
                  <Clock className="w-10 h-10 stroke-1 mb-2 text-zinc-300 dark:text-zinc-600" />
                  <p className="text-sm font-medium">No sessions recorded yet</p>
                  <p className="text-xs text-zinc-500 mt-1">Start a focus session to see your progress here.</p>
                </div>
              ) : (
                filtered.map((item) => {
                  const isCompleted = item.status === 'completed';
                  return (
                    <div
                      key={item.id}
                      className="p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-100 dark:border-zinc-800/80 hover:border-zinc-300 dark:hover:border-zinc-700 transition-all flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm tracking-tight capitalize">
                            {getModeLabel(item.mode)}
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                            isCompleted
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'bg-zinc-500/10 text-zinc-500'
                          }`}>
                            {item.status}
                          </span>
                        </div>
                        <span className={`text-xs font-bold flex items-center gap-1 ${
                          item.xpAwarded > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'
                        }`}>
                          <Award className="w-3.5 h-3.5" />
                          +{item.xpAwarded} XP
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                        <span className="flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" />
                          {item.durationMinutes} minutes
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Calendar className="w-3.5 h-3.5" />
                          {formatSessionDate(item.startedAt)}
                        </span>
                      </div>

                      {item.xpReason && (
                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 border-t border-zinc-100 dark:border-zinc-800/60 pt-2 mt-1">
                          {item.xpReason === 'qualified'
                            ? '✓ Full target duration reached'
                            : item.xpReason === 'below_min_duration'
                            ? '⚠ Under 10-minute threshold'
                            : item.xpReason === 'daily_cap_reached'
                            ? '★ Daily XP cap attained'
                            : item.xpReason}
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-zinc-100 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-900/30 text-center">
              <span className="text-xs text-zinc-400">
                Server-authoritative focus telemetry
              </span>
            </div>
          </motion.div>
        </div>
      </div>
    </AnimatePresence>
  );
};
