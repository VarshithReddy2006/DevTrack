import React, { useEffect, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Clock,
  Code2,
  Eye,
  EyeOff,
  Flame,
  MessageSquare,
  RotateCcw,
  Sparkles,
  Zap,
} from 'lucide-react';
import type {
  CrashCourseBlock,
  CrashCoursePlan,
  CrashCourseWindow,
} from '../../../services/readinessService';
import { INTERVIEW_STUDIO_FLAG, INTERVIEW_STUDIO_PATH } from '../../interview/interview';
import { useFeatureFlags } from '../../flags/hooks/useFeatureFlags';

export interface CrashCourseWorkspaceProps {
  window: CrashCourseWindow;
  onWindowChange: (next: CrashCourseWindow) => void;
  plan: CrashCoursePlan | null | undefined;
  isLoading: boolean;
  error?: string | null;
  onRetry?: () => void;
  onMarkTopicRevised?: (skill: string, revised: boolean) => Promise<void> | void;
}

const WINDOW_OPTIONS: Array<{ id: CrashCourseWindow; label: string; sub: string }> = [
  { id: '48h', label: '48-Hour Blitz', sub: 'Top 3 Pareto' },
  { id: '7d', label: '7-Day Intensive', sub: 'Top 5 Pareto' },
  { id: '14d', label: '14-Day Sprint', sub: 'Top 7 Pareto' },
];

type QaRating = 'got_it' | 'review_again';

const STORAGE_PREFIX = 'devtrack:crash-course';

function readStoredMap<T extends string | boolean>(key: string): Record<string, T> {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeStoredMap<T extends string | boolean>(key: string, value: Record<string, T>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage errors in restricted contexts
  }
}

export const CrashCourseWorkspace: React.FC<CrashCourseWorkspaceProps> = ({
  window: activeWindow,
  onWindowChange,
  plan,
  isLoading,
  error,
  onRetry,
  onMarkTopicRevised,
}) => {
  const inRouter = useInRouterContext();
  const { isEnabled } = useFeatureFlags();
  const [selectedBlockId, setSelectedBlockId] = useState<string>('');
  const [revealedAnswers, setRevealedAnswers] = useState<Record<string, boolean>>({});
  const [qaRatings, setQaRatings] = useState<Record<string, QaRating>>(() =>
    readStoredMap<QaRating>(`${STORAGE_PREFIX}:qa:${activeWindow}`)
  );
  const [revisedBlocks, setRevisedBlocks] = useState<Record<string, boolean>>(() =>
    readStoredMap<boolean>(`${STORAGE_PREFIX}:revised:${activeWindow}`)
  );

  useEffect(() => {
    setQaRatings(readStoredMap<QaRating>(`${STORAGE_PREFIX}:qa:${activeWindow}`));
    setRevisedBlocks(readStoredMap<boolean>(`${STORAGE_PREFIX}:revised:${activeWindow}`));
    setRevealedAnswers({});
  }, [activeWindow]);

  useEffect(() => {
    if (plan?.blocks.length) {
      const stillExists = plan.blocks.some((b) => b.blockId === selectedBlockId);
      if (!stillExists) {
        setSelectedBlockId(plan.blocks[0].blockId);
      }
    } else {
      setSelectedBlockId('');
    }
  }, [plan, selectedBlockId]);

  const activeBlock: CrashCourseBlock | null =
    plan?.blocks.find((b) => b.blockId === selectedBlockId) ?? plan?.blocks[0] ?? null;

  const revisedCount = plan
    ? plan.blocks.filter((b) => Boolean(revisedBlocks[b.blockId])).length
    : 0;
  const totalCount = plan?.blocks.length ?? 0;
  const progressPct = totalCount > 0 ? Math.round((revisedCount / totalCount) * 100) : 0;

  const toggleAnswer = (qaKey: string) => {
    setRevealedAnswers((prev) => ({ ...prev, [qaKey]: !prev[qaKey] }));
  };

  const rateQuestion = (qaKey: string, rating: QaRating) => {
    setQaRatings((prev) => {
      const next = { ...prev, [qaKey]: rating };
      writeStoredMap(`${STORAGE_PREFIX}:qa:${activeWindow}`, next);
      return next;
    });
  };

  const toggleBlockRevised = async (block: CrashCourseBlock) => {
    const nextVal = !revisedBlocks[block.blockId];
    setRevisedBlocks((prev) => {
      const next = { ...prev, [block.blockId]: nextVal };
      writeStoredMap(`${STORAGE_PREFIX}:revised:${activeWindow}`, next);
      return next;
    });
    if (onMarkTopicRevised) {
      await onMarkTopicRevised(block.skill, nextVal);
    }
  };

  const renderActionLink = (to: string, className: string, children: React.ReactNode) =>
    inRouter ? (
      <Link to={to} className={className}>
        {children}
      </Link>
    ) : (
      <a href={to} className={className}>
        {children}
      </a>
    );

  return (
    <div className="space-y-6 min-w-0">
      {/* Crunch Banner */}
      <section className="rounded-2xl bg-gradient-to-br from-indigo-950 via-slate-900 to-indigo-900 text-white p-6 md:p-7 shadow-lg relative overflow-hidden">
        <div className="absolute top-0 right-0 w-72 h-72 bg-indigo-500/20 rounded-full blur-[90px] -mr-20 -mt-20 pointer-events-none" />
        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
          <div className="space-y-2 min-w-0">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/20 border border-amber-300/30 px-3 py-1 text-[11px] font-bold text-amber-200 uppercase tracking-wider">
              <Zap size={12} /> Rapid Revision Blitz · 80/20 Pareto Mode
            </div>
            <h2 className="text-2xl font-black tracking-tight">
              {plan?.targetRole ? `${plan.targetRole} Crash Course` : 'Interview Crash Course'}
            </h2>
            <p className="text-sm text-indigo-200 max-w-2xl">
              High-yield 5-minute cheat sheets, classic interview gotchas, and active-recall Q&A drills prioritized by interview frequency.
            </p>
          </div>

          {/* Window Switcher */}
          <div className="flex flex-wrap gap-2 rounded-2xl bg-white/10 p-1.5 border border-white/15 shrink-0">
            {WINDOW_OPTIONS.map((opt) => {
              const selected = activeWindow === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onWindowChange(opt.id)}
                  className={`px-3.5 py-2 rounded-xl text-left transition-colors cursor-pointer whitespace-nowrap ${
                    selected
                      ? 'bg-white text-indigo-950 shadow-sm'
                      : 'text-indigo-100 hover:bg-white/10'
                  }`}
                >
                  <div className="text-xs font-bold leading-tight">{opt.label}</div>
                  <div className={`text-[10px] font-medium ${selected ? 'text-indigo-600' : 'text-indigo-300'}`}>
                    {opt.sub}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Summary Stats & Progress */}
        {plan && (
          <div className="relative z-10 mt-6 pt-5 border-t border-white/10 grid grid-cols-1 sm:grid-cols-3 gap-4 items-center">
            <div className="flex items-center gap-6">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-300">Pareto Filter</div>
                <div className="text-lg font-black tabular-nums">Top {plan.paretoSkillCount} Pareto Skills</div>
              </div>
              <div className="w-px h-8 bg-white/15" />
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-300">Estimated Blitz</div>
                <div className="text-lg font-black tabular-nums">{plan.totalHoursLabel}</div>
              </div>
            </div>

            <div className="sm:col-span-2 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-semibold">
                <span className="text-indigo-200">Rapid Revision Completion</span>
                <span className="tabular-nums text-white">{revisedCount} / {totalCount} topics revised ({progressPct}%)</span>
              </div>
              <div className="w-full h-2 rounded-full bg-white/15 overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-pulse">
          <div className="lg:col-span-4 h-64 rounded-2xl bg-slate-200/60" />
          <div className="lg:col-span-8 h-64 rounded-2xl bg-slate-200/60" />
        </div>
      )}

      {!isLoading && error && (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-5 flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-rose-800">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-xl bg-white border border-rose-200 px-3.5 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 cursor-pointer"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {!isLoading && !error && plan && activeBlock && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start min-w-0">
          {/* Left: Day-by-Day Blitz Schedule Cards */}
          <div className="lg:col-span-4 space-y-3 min-w-0">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 px-1">
              Day-by-Day Revision Schedule
            </h3>
            {plan.blocks.map((block, idx) => {
              const selected = block.blockId === activeBlock.blockId;
              const isDone = Boolean(revisedBlocks[block.blockId]);
              return (
                <button
                  key={block.blockId}
                  type="button"
                  onClick={() => setSelectedBlockId(block.blockId)}
                  className={`w-full text-left rounded-2xl border p-4 transition-all cursor-pointer ${
                    selected
                      ? 'border-indigo-400 bg-indigo-50/70 ring-2 ring-indigo-100 shadow-xs'
                      : 'border-slate-200/80 bg-white hover:border-indigo-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md">
                      Block {idx + 1} · {block.dayLabel}
                    </span>
                    <span className="text-[11px] font-semibold text-slate-500 tabular-nums inline-flex items-center gap-1">
                      <Clock size={11} /> {block.revisionMinutes}m
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-bold text-slate-900 truncate">{block.title}</h4>
                    {isDone && (
                      <CheckCircle2 size={16} className="text-emerald-600 shrink-0" aria-label="Revised" />
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mt-1 line-clamp-2">{block.whySelected}</p>
                </button>
              );
            })}
          </div>

          {/* Right: Cheat Sheet + Active-Recall Flashcards */}
          <div className="lg:col-span-8 rounded-2xl border border-slate-200/80 bg-white p-6 shadow-xs space-y-6 min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <span className="rounded-md bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-700">
                    {activeBlock.dayLabel}
                  </span>
                  <span className="rounded-md bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-800 tabular-nums">
                    Pareto {activeBlock.paretoPriority}/10
                  </span>
                  <span className="text-xs font-semibold text-slate-500 tabular-nums">
                    ~{activeBlock.revisionMinutes}m cheat sheet
                  </span>
                </div>
                <h3 className="text-xl font-bold text-slate-900">{activeBlock.skill} Rapid Cheat Sheet</h3>
              </div>

              <button
                type="button"
                onClick={() => void toggleBlockRevised(activeBlock)}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                  revisedBlocks[activeBlock.blockId]
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <CheckCircle2 size={14} className={revisedBlocks[activeBlock.blockId] ? 'text-emerald-600' : 'text-slate-400'} />
                {revisedBlocks[activeBlock.blockId] ? 'Topic Revised' : 'Mark Topic Revised'}
              </button>
            </div>

            {/* 5-Minute Core Concepts & Interview Gotchas */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-4">
                <div className="flex items-center gap-2 mb-2.5">
                  <BookOpen size={15} className="text-indigo-600 shrink-0" />
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    5-Minute Core Concepts
                  </h4>
                </div>
                <ul className="space-y-2">
                  {activeBlock.crashCourse.coreConcepts.map((bullet, i) => (
                    <li key={i} className="text-xs text-slate-700 leading-relaxed flex items-start gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 mt-1.5 shrink-0" />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl border border-amber-200/80 bg-amber-50/50 p-4">
                <div className="flex items-center gap-2 mb-2.5">
                  <AlertTriangle size={15} className="text-amber-600 shrink-0" />
                  <h4 className="text-xs font-bold uppercase tracking-wider text-amber-900">
                    Interview Gotchas
                  </h4>
                </div>
                <ul className="space-y-2">
                  {activeBlock.crashCourse.gotchas.map((gotcha, i) => (
                    <li key={i} className="text-xs text-amber-950/90 leading-relaxed flex items-start gap-2">
                      <Flame size={12} className="text-amber-600 mt-0.5 shrink-0" />
                      <span>{gotcha}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Active-Recall Rapid Q&A Drill */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles size={15} className="text-indigo-600" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Rapid Q&amp;A Active-Recall Drill
                </h4>
              </div>

              <div className="space-y-3">
                {activeBlock.crashCourse.rapidQA.map((qa, idx) => {
                  const qaKey = `${activeBlock.blockId}-qa-${idx}`;
                  const revealed = Boolean(revealedAnswers[qaKey]);
                  const rating = qaRatings[qaKey];
                  return (
                    <div
                      key={qaKey}
                      className="rounded-xl border border-slate-200 bg-slate-50/40 p-4 space-y-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <p className="text-sm font-semibold text-slate-900 flex-1 min-w-0">
                          {idx + 1}. {qa.question}
                        </p>
                        <button
                          type="button"
                          onClick={() => toggleAnswer(qaKey)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors shrink-0 cursor-pointer"
                        >
                          {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                          {revealed ? 'Hide Answer' : 'Reveal Answer'}
                        </button>
                      </div>

                      {revealed && (
                        <div className="rounded-lg border border-slate-200 bg-white p-3.5 space-y-3">
                          <p className="text-xs text-slate-700 leading-relaxed">{qa.answer}</p>
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
                            <span className="text-[11px] font-medium text-slate-500">Rate your recall:</span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => rateQuestion(qaKey, 'got_it')}
                                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                                  rating === 'got_it'
                                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                                }`}
                              >
                                <CheckCircle2 size={12} /> Got It
                              </button>
                              <button
                                type="button"
                                onClick={() => rateQuestion(qaKey, 'review_again')}
                                className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                                  rating === 'review_again'
                                    ? 'border-amber-300 bg-amber-50 text-amber-800'
                                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                                }`}
                              >
                                <RotateCcw size={12} /> Review Again
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Quick Action Bar */}
            <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center gap-2.5">
              {renderActionLink(
                `/focus?mission=${encodeURIComponent(`Blitz: ${activeBlock.skill}`)}&duration=15&mode=core`,
                'inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors whitespace-nowrap',
                <>
                  <Clock size={13} aria-hidden="true" />
                  Start 15m Blitz Focus
                </>
              )}
              {renderActionLink(
                '/readiness/dsa',
                'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap',
                <>
                  <Code2 size={13} aria-hidden="true" className="text-indigo-600" />
                  Practice DSA Pattern
                </>
              )}
              {isEnabled(INTERVIEW_STUDIO_FLAG) &&
                renderActionLink(
                  INTERVIEW_STUDIO_PATH,
                  'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap',
                  <>
                    <MessageSquare size={13} aria-hidden="true" className="text-indigo-600" />
                    Quick Mock Interview
                  </>
                )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
