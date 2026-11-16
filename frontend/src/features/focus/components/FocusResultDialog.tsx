import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Award, CheckCircle2, AlertTriangle, Sparkles, X, Clock, Flame } from 'lucide-react';
import type { FocusSessionModel } from '../services/focusService';

interface FocusResultDialogProps {
  isOpen: boolean;
  onClose: () => void;
  result: FocusSessionModel | null;
}

export const FocusResultDialog: React.FC<FocusResultDialogProps> = ({
  isOpen,
  onClose,
  result,
}) => {
  if (!isOpen || !result) return null;

  const xpAwarded = result.xpAwarded ?? 25;
  const reason = result.xpReason || (xpAwarded > 0 ? 'qualified' : 'below_min_duration');
  const durationMins = Math.round((result.plannedSec || 1500) / 60);

  const getReasonExplanation = (r: string) => {
    switch (r) {
      case 'qualified':
        return {
          title: 'Full XP Credited',
          desc: 'Outstanding focus! You achieved your target duration with consistent active heartbeats.',
          type: 'success',
        };
      case 'below_min_duration':
        return {
          title: 'Minimum Duration Not Met',
          desc: 'Sessions must run for at least 10 minutes without interruption to qualify for XP rewards.',
          type: 'warning',
        };
      case 'daily_cap_reached':
        return {
          title: 'Daily XP Cap Reached',
          desc: 'You have maxed out your daily focus XP allowance. Keep going for habit momentum!',
          type: 'info',
        };
      case 'below_heartbeat_coverage':
        return {
          title: 'Telemetry Threshold Low',
          desc: 'Active heartbeat verification was below the required threshold to guarantee presence.',
          type: 'warning',
        };
      default:
        return {
          title: 'Session Logged',
          desc: 'Your focus session duration was saved to your daily productivity timeline.',
          type: 'info',
        };
    }
  };

  const reasonInfo = getReasonExplanation(reason);

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          transition={{ type: 'spring', stiffness: 350, damping: 25 }}
          className="relative w-full max-w-md bg-white dark:bg-[#121217] border border-zinc-200 dark:border-zinc-800 rounded-3xl shadow-2xl p-6 sm:p-8 text-zinc-900 dark:text-zinc-100 overflow-hidden"
        >
          {/* Top Decorative Glow */}
          <div className="absolute -top-16 left-1/2 -translate-x-1/2 w-48 h-48 bg-gradient-to-br from-emerald-500/20 to-teal-500/10 blur-3xl pointer-events-none rounded-full" />

          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Header Icon */}
          <div className="flex flex-col items-center text-center">
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 ${
              xpAwarded > 0
                ? 'bg-emerald-500/10 text-emerald-500 ring-8 ring-emerald-500/5'
                : 'bg-amber-500/10 text-amber-500 ring-8 ring-amber-500/5'
            }`}>
              {xpAwarded > 0 ? (
                <Sparkles className="w-8 h-8 animate-pulse" />
              ) : (
                <AlertTriangle className="w-8 h-8" />
              )}
            </div>

            <h3 className="text-2xl font-bold tracking-tight">
              Focus Session Completed
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
              {result.mode ? result.mode.replace('_', ' ').toUpperCase() : 'DEEP WORK'}
            </p>
          </div>

          {/* XP Banner */}
          <div className="mt-6 p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-indigo-500/10 text-indigo-500">
                <Clock className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Duration</p>
                <p className="text-base font-semibold">{durationMins} minutes</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className={`px-3.5 py-1.5 rounded-xl font-bold text-sm flex items-center gap-1.5 ${
                xpAwarded > 0
                  ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/20'
                  : 'bg-zinc-200 dark:bg-zinc-800 text-zinc-500'
              }`}>
                <Award className="w-4 h-4" />
                <span>+{xpAwarded} XP</span>
              </div>
            </div>
          </div>

          {/* XP Breakdown & Reason Explanation */}
          <div className="mt-4 p-4 rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-100 dark:border-zinc-800/80">
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                {reasonInfo.type === 'success' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                )}
              </div>
              <div>
                <h4 className="text-sm font-semibold">{reasonInfo.title}</h4>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                  {reasonInfo.desc}
                </p>
              </div>
            </div>
          </div>

          {/* Streak Encouragement */}
          <div className="mt-4 flex items-center justify-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            <Flame className="w-4 h-4 text-orange-500" />
            <span>Daily focus streak preserved & amplified</span>
          </div>

          {/* Action button */}
          <button
            onClick={onClose}
            className="mt-6 w-full py-3.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-2xl shadow-lg shadow-emerald-600/20 transition-all hover:scale-[1.01] active:scale-[0.99]"
          >
            Done & Continue
          </button>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
