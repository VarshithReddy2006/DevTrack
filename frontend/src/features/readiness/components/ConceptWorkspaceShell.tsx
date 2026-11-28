import React, { useEffect, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import {
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Gauge,
  GitBranch,
  MessageSquare,
  RotateCcw,
  Search,
  Sparkles,
  Zap,
} from 'lucide-react';
import type {
  ConceptConfidence,
  ConceptItem,
  ConceptLevel,
} from '../../../services/readinessService';
import { INTERVIEW_STUDIO_FLAG, INTERVIEW_STUDIO_PATH } from '../../interview/interview';
import { useFeatureFlags } from '../../flags/hooks/useFeatureFlags';

export const LEVEL_LABELS: Record<ConceptLevel, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
  'case-study': 'Case Studies',
};

const LEVEL_BADGE_CLASSES: Record<ConceptLevel, string> = {
  beginner: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  intermediate: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  advanced: 'border-purple-200 bg-purple-50 text-purple-700',
  'case-study': 'border-amber-200 bg-amber-50 text-amber-800',
};

export interface ConceptWorkspaceShellProps {
  concepts: ConceptItem[];
  filteredConcepts: ConceptItem[];
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  flowHeading: string;
  matrixHeading: string;
  benchmarkHeading: string;
  focusMinutes: number;
  focusButtonLabel: string;
  interviewButtonLabel: string;
  onUpdateConcept: (
    conceptId: string,
    patch: { completed?: boolean; confidence?: ConceptConfidence | null }
  ) => void;
  isUpdating?: boolean;
  filterControls?: React.ReactNode;
}

export const ConceptWorkspaceShell: React.FC<ConceptWorkspaceShellProps> = ({
  concepts,
  filteredConcepts,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  flowHeading,
  matrixHeading,
  benchmarkHeading,
  focusMinutes,
  focusButtonLabel,
  interviewButtonLabel,
  onUpdateConcept,
  isUpdating = false,
  filterControls,
}) => {
  const inRouter = useInRouterContext();
  const { isEnabled } = useFeatureFlags();
  const [selectedId, setSelectedId] = useState<string>('');
  const [revealedAnswers, setRevealedAnswers] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (filteredConcepts.length === 0) {
      setSelectedId('');
      return;
    }
    const stillVisible = filteredConcepts.some((c) => c.id === selectedId);
    if (!stillVisible) {
      setSelectedId(filteredConcepts[0].id);
    }
  }, [filteredConcepts, selectedId]);

  const activeConcept: ConceptItem | null =
    filteredConcepts.find((c) => c.id === selectedId) ??
    filteredConcepts[0] ??
    concepts[0] ??
    null;

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
      {/* Filter & Search Toolbar */}
      <div className="rounded-2xl bg-white border border-slate-200/80 p-4 shadow-xs space-y-3 min-w-0">
        {filterControls}
        <div className="relative">
          <Search
            size={15}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="w-full rounded-xl border border-slate-200 bg-slate-50/70 pl-9 pr-4 py-2 text-xs font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      {/* Master-Detail Canvas */}
      {filteredConcepts.length === 0 || !activeConcept ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center">
          <p className="text-sm font-semibold text-slate-700">
            No matching topics found.
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Adjust your filter pills or clear the search box to browse the full curriculum.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start min-w-0">
          {/* Left Rail */}
          <aside
            aria-label="Concept topics"
            className="lg:col-span-4 space-y-2.5 lg:max-h-[780px] lg:overflow-y-auto lg:pr-1 min-w-0"
          >
            {filteredConcepts.map((item, idx) => {
              const isSelected = item.id === activeConcept.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left rounded-2xl border p-4 transition-all cursor-pointer ${
                    isSelected
                      ? 'border-indigo-400 bg-indigo-50/70 ring-2 ring-indigo-100 shadow-xs'
                      : 'border-slate-200/80 bg-white hover:border-indigo-200 hover:bg-slate-50/50'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${LEVEL_BADGE_CLASSES[item.level]}`}
                      >
                        {LEVEL_LABELS[item.level]}
                      </span>
                      {item.isOptional && (
                        <span className="rounded-md border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-bold text-teal-800">
                          Optional · If Interested
                        </span>
                      )}
                      {item.isHighFrequencyCrashCourse && (
                        <span
                          title="High-frequency interview screening topic"
                          className="inline-flex items-center gap-0.5 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-800"
                        >
                          <Zap size={10} /> Blitz
                        </span>
                      )}
                    </div>
                    {item.completed && (
                      <CheckCircle2
                        size={16}
                        className="text-emerald-600 shrink-0"
                        aria-label="Mastered"
                      />
                    )}
                  </div>
                  <div className="text-sm font-bold text-slate-900 leading-snug">
                    {idx + 1}. {item.title}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                    <span className="truncate">{item.subtitle}</span>
                    <span className="shrink-0 tabular-nums font-semibold">
                      {item.estimatedMinutes}m
                    </span>
                  </div>
                </button>
              );
            })}
          </aside>

          {/* Right Detail Canvas */}
          <main className="lg:col-span-8 rounded-2xl border border-slate-200/80 bg-white p-6 md:p-7 shadow-xs space-y-6 min-w-0">
            {/* Title + Mastery Toggle */}
            <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-slate-100">
              <div className="space-y-2 min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-md border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${LEVEL_BADGE_CLASSES[activeConcept.level]}`}
                  >
                    {LEVEL_LABELS[activeConcept.level]}
                  </span>
                  {activeConcept.subTrack && (
                    <span className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                      {activeConcept.subTrack === 'distributed-systems'
                        ? 'Distributed Systems · Optional'
                        : activeConcept.subTrack.toUpperCase()}
                    </span>
                  )}
                  <span className="text-xs font-semibold text-slate-500 inline-flex items-center gap-1 tabular-nums">
                    <Clock size={12} /> ~{activeConcept.estimatedMinutes} min study
                  </span>
                </div>
                <h2 className="text-xl md:text-2xl font-bold text-slate-900 tracking-tight">
                  {activeConcept.title}
                </h2>
                <p className="text-sm text-slate-600 leading-relaxed">
                  {activeConcept.summary}
                </p>
              </div>

              <button
                type="button"
                disabled={isUpdating}
                onClick={() =>
                  onUpdateConcept(activeConcept.id, {
                    completed: !activeConcept.completed,
                  })
                }
                className={`inline-flex items-center gap-1.5 rounded-xl border px-4 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60 ${
                  activeConcept.completed
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                    : 'border-indigo-200 bg-indigo-600 text-white hover:bg-indigo-700'
                }`}
              >
                <CheckCircle2 size={14} />
                {activeConcept.completed ? 'Mastered' : 'Mark Complete'}
              </button>
            </div>

            {/* Architecture Flow / Concept Breakdown */}
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <GitBranch size={15} className="text-indigo-600 shrink-0" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  {flowHeading}
                </h3>
              </div>
              <ol className="space-y-2">
                {activeConcept.architectureFlow.map((step, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-3 rounded-xl border border-slate-200/80 bg-slate-50/70 px-4 py-3 text-xs text-slate-700 leading-relaxed"
                  >
                    <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </section>

            {/* Trade-Off / Side-by-Side Matrix */}
            {activeConcept.tradeOffs.length > 0 && (
              <section className="space-y-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  {matrixHeading}
                </h3>
                <div className="overflow-x-auto rounded-xl border border-slate-200/80">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500 border-b border-slate-200/80">
                      <tr>
                        <th className="px-4 py-2.5">Pattern / Option</th>
                        <th className="px-4 py-2.5">When to Use</th>
                        <th className="px-4 py-2.5">When to Avoid</th>
                        <th className="px-4 py-2.5">Alternative</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {activeConcept.tradeOffs.map((row) => (
                        <tr key={row.topic} className="align-top hover:bg-slate-50/50">
                          <td className="px-4 py-3 font-bold text-slate-900">
                            {row.topic}
                          </td>
                          <td className="px-4 py-3 text-emerald-900 bg-emerald-50/20">
                            {row.whenToUse}
                          </td>
                          <td className="px-4 py-3 text-rose-900 bg-rose-50/20">
                            {row.whenToAvoid}
                          </td>
                          <td className="px-4 py-3 text-slate-600">
                            {row.alternative || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Scale / Performance Benchmarks */}
            {activeConcept.scaleBenchmarks.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Gauge size={15} className="text-amber-600 shrink-0" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    {benchmarkHeading}
                  </h3>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {activeConcept.scaleBenchmarks.map((b) => (
                    <div
                      key={b.label}
                      className="rounded-xl border border-slate-200/80 bg-slate-50/60 p-3.5"
                    >
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                        {b.label}
                      </div>
                      <div className="text-base font-black text-slate-900 mt-0.5 tabular-nums">
                        {b.value}
                      </div>
                      {b.note && (
                        <p className="text-[11px] text-slate-500 mt-1 leading-snug">
                          {b.note}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Active-Recall Interview Q&A */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Sparkles size={15} className="text-indigo-600" />
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                    Active-Recall Interview Q&amp;A
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-medium text-slate-500">
                    Topic Recall:
                  </span>
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() =>
                      onUpdateConcept(activeConcept.id, {
                        confidence: 'got_it',
                        completed: true,
                      })
                    }
                    className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                      activeConcept.confidence === 'got_it'
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <CheckCircle2 size={12} /> Got It
                  </button>
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() =>
                      onUpdateConcept(activeConcept.id, {
                        confidence: 'revise_again',
                      })
                    }
                    className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                      activeConcept.confidence === 'revise_again'
                        ? 'border-amber-300 bg-amber-50 text-amber-800'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <RotateCcw size={12} /> Revise Again
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {activeConcept.rapidQA.map((qa, i) => {
                  const revealed = Boolean(revealedAnswers[qa.id]);
                  return (
                    <div
                      key={qa.id}
                      className="rounded-xl border border-slate-200 bg-slate-50/40 p-4 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <p className="text-sm font-semibold text-slate-900 flex-1 min-w-0">
                          {i + 1}. {qa.question}
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            setRevealedAnswers((prev) => ({
                              ...prev,
                              [qa.id]: !prev[qa.id],
                            }))
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors shrink-0 cursor-pointer"
                        >
                          {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                          {revealed ? 'Hide Answer' : 'Reveal Answer'}
                        </button>
                      </div>
                      {revealed && (
                        <div className="rounded-lg border border-slate-200 bg-white p-3.5 text-xs text-slate-700 leading-relaxed">
                          {qa.answer}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Whiteboard / Practice Prompt + Action Bridges */}
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-600">
                  Design Whiteboard Exercise
                </div>
                <p className="text-xs font-medium text-slate-700 mt-1 leading-relaxed">
                  {activeConcept.practicePrompt}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {renderActionLink(
                  `/focus?mission=${encodeURIComponent(activeConcept.title)}&duration=${focusMinutes}&mode=core`,
                  'inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors whitespace-nowrap',
                  <>
                    <Clock size={13} aria-hidden="true" />
                    {focusButtonLabel}
                  </>
                )}
                {isEnabled(INTERVIEW_STUDIO_FLAG) &&
                  renderActionLink(
                    INTERVIEW_STUDIO_PATH,
                    'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap',
                    <>
                      <MessageSquare size={13} aria-hidden="true" className="text-indigo-600" />
                      {interviewButtonLabel}
                    </>
                  )}
              </div>
            </div>
          </main>
        </div>
      )}
    </div>
  );
};
